/**
 * Duxre RevOps Dashboard — Live Data Fetcher
 * Updated: Uses Stripe as source of truth for New Ignites
 */

const axios = require('axios');
const fs = require('fs');

function today() {
  return new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago'
  });
}
function mtdStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}
function todayStr() {
  return new Date().toISOString().split('T')[0];
}
function mtdStartUnix() {
  const d = new Date();
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
}

// ─── MIXPANEL ────────────────────────────────────────────────────────────────
async function fetchMixpanel() {
  console.log('📊 Fetching Mixpanel logins...');
  try {
    const auth = Buffer.from(
      `${process.env.MIXPANEL_SERVICE_ACCOUNT_USERNAME}:${process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET}`
    ).toString('base64');
    const from = mtdStart();
    const to = todayStr();
    const projectId = process.env.MIXPANEL_PROJECT_ID;
    const events = ['Login - Dashboard', 'Login - Marketplace', 'Login - Microsite'];
    const results = {};
    for (const event of events) {
      const res = await axios.get('https://data.mixpanel.com/api/2.0/export', {
        params: { project_id: projectId, from_date: from, to_date: to, event: JSON.stringify([event]) },
        headers: { Authorization: `Basic ${auth}` },
        responseType: 'text'
      });
      results[event] = res.data.trim().split('\n').filter(l => l.trim()).length;
      console.log(`  ✅ ${event}: ${results[event]}`);
    }
    return {
      dashboard: results['Login - Dashboard'] || 0,
      marketplace: results['Login - Marketplace'] || 0,
      microsite: results['Login - Microsite'] || 0,
      total: Object.values(results).reduce((a, b) => a + b, 0)
    };
  } catch (e) {
    console.error('❌ Mixpanel error:', e.message);
    return null;
  }
}

// ─── HUBSPOT ────────────────────────────────────────────────────────────────
async function fetchHubSpot() {
  console.log('🏢 Fetching HubSpot pipeline...');
  try {
    const headers = { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}` };
    const from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

    // Demos Booked MTD
    const demosRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      { filterGroups: [{ filters: [
        { propertyName: 'dealstage', operator: 'EQ', value: '1083942046' },
        { propertyName: 'createdate', operator: 'GTE', value: String(from) }
      ]}], properties: ['dealname'], limit: 100 },
      { headers }
    );
    const demosCount = demosRes.data.total || 0;
    console.log(`  ✅ Demos booked MTD: ${demosCount}`);

    // Active pipeline
    const pipelineRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      { filterGroups: [{ filters: [
        { propertyName: 'dealstage', operator: 'IN',
          values: ['1083942044','1083942045','1083942046','1083942047','1083942048'] }
      ]}], properties: ['dealname','dealstage','closedate','hubspot_owner_id'],
        limit: 100, sorts: [{ propertyName: 'closedate', direction: 'ASCENDING' }] },
      { headers }
    );
    const deals = pipelineRes.data.results || [];
    const hot = deals.filter(d => d.properties.dealstage === '1083942046').length;
    const warm = deals.filter(d => ['1083942044','1083942045'].includes(d.properties.dealstage)).length;
    console.log(`  ✅ Pipeline: ${deals.length} total (hot: ${hot}, warm: ${warm})`);

            // Power Brokers — manually maintained (4 Apex + 29 Ignite = 33)
    console.log('  ℹ️ Power Brokers: manually maintained — skipping auto-update');;
  } catch (e) {
    console.error('❌ HubSpot error:', e.message);
    return null;
  }
}

// ─── STRIPE ──────────────────────────────────────────────────────────────────
async function fetchStripe() {
  console.log('💳 Fetching Stripe data...');
  try {
    const headers = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
    const mtdUnix = mtdStartUnix();

    // Get ALL active subscriptions with pagination
    let allSubs = [];
    let startingAfter = null;
    let hasMore = true;
    while (hasMore) {
      const params = { status: 'active', limit: 100, expand: ['data.items.data.price'] };
      if (startingAfter) params.starting_after = startingAfter;
      const res = await axios.get('https://api.stripe.com/v1/subscriptions', { params, headers });
      allSubs = allSubs.concat(res.data.data);
      hasMore = res.data.has_more;
      if (hasMore && res.data.data.length > 0)
        startingAfter = res.data.data[res.data.data.length - 1].id;
    }

    // New Ignites MTD = subscriptions created this month
    const newIgnitesMTD = allSubs.filter(s => s.created >= mtdUnix).length;
    console.log(`  ✅ New Ignites MTD (Stripe created this month): ${newIgnitesMTD}`);

    // Total subscriptions
    const totalSubs = allSubs.length;

    // Calculate ARR
    const APEX_PRICE_IDS = [
      'price_1SdzXGEEbsKUaWNi4K5gwoLQ','price_1SdzXhEEbsKUaWNiClKBMPb8',
      'price_1SdzWnEEbsKUaWNiI26ebPjI','price_1RrgRzEEbsKUaWNiDvmGJdVA',
      'price_1RrgRaEEbsKUaWNiPb0kS1qE','price_1RrgPIEEbsKUaWNiRc0pISV7',
      'price_1T5Y5LEEbsKUaWNifi3K1vHs','price_1ScequEEbsKUaWNimRFnLwW8'
    ];
    let apexCount = 0, monthlyRevenue = 0;
    for (const sub of allSubs) {
      for (const item of sub.items.data) {
        if (APEX_PRICE_IDS.includes(item.price.id)) apexCount++;
        if (item.price.unit_amount) monthlyRevenue += (item.price.unit_amount / 100) * (item.quantity || 1);
      }
    }
    const arr = Math.round(monthlyRevenue * 12);
    const arrStr = arr >= 1000 ? `$${Math.round(arr/1000)}K` : `$${arr}`;
    console.log(`  ✅ Total subs: ${totalSubs}, Apex: ${apexCount}, ARR: ${arrStr}`);
    console.log(`  ✅ New Ignites MTD: ${newIgnitesMTD}`);

    return { total: totalSubs, apexCount, monthlyRevenue, arr, arrStr, newIgnitesMTD };
  } catch (e) {
    console.error('❌ Stripe error:', e.message);
    return null;
  }
}

// ─── UPDATE DATA.JS ──────────────────────────────────────────────────────────
async function updateDataJs(mixpanel, hubspot, stripe, sendgrid) {
  console.log('\n📝 Updating data.js...');
  let data = fs.readFileSync('data.js', 'utf8');
  const todayDate = today();

  // Date
  data = data.replace(/updated: "[^"]+"/g, `updated: "${todayDate}"`);
  console.log(`  ✅ Date → ${todayDate}`);

  // Mixpanel logins
  if (mixpanel) {
    const total = mixpanel.total.toLocaleString();
    data = data.replace(/dashboard: \d+,/, `dashboard: ${mixpanel.dashboard},`);
    data = data.replace(/marketplace: \d+,/, `marketplace: ${mixpanel.marketplace},`);
    data = data.replace(/microsite: \d+/, `microsite: ${mixpanel.microsite}`);
    data = data.replace(
      /{ label: "Broker Logins[^}]+}/,
      `{ label: "Broker Logins — Apr MTD", value: "${total}", sub: "Dashboard ${mixpanel.dashboard} · Marketplace ${mixpanel.marketplace} · Microsite ${mixpanel.microsite} · Live ${todayDate}" }`
    );
    console.log(`  ✅ Broker Logins → ${total}`);
  }

  // HubSpot
  if (hubspot) {
    if (hubspot.demosCount > 0 && hubspot.demosCount < 50) {
      data = data.replace(
        /{ label: "Demos Booked MTD", value: "\d+", goal: 20, sub: "[^"]+", color: "[^"]+" }/,
        `{ label: "Demos Booked MTD", value: "${hubspot.demosCount}", goal: 20, sub: "${Math.round(hubspot.demosCount/20*100)}% to goal · HubSpot live ${todayDate}", color: "#EE3135" }`
      );
      console.log(`  ✅ Demos → ${hubspot.demosCount}`);
    }
    if (hubspot.powerBrokers > 0) {
      data = data.replace(
        /{ label: "Power Brokers"[^}]+}/,
        `{ label: "Power Brokers", value: "${hubspot.powerBrokers} /50", goal: 50, sub: "HubSpot live · ${hubspot.powerBrokers} tagged", color: "#282828" }`
      );
      console.log(`  ✅ Power Brokers → ${hubspot.powerBrokers}`);
    }
  }

  // Stripe — New Ignites MTD + ARR
  if (stripe) {
    if (stripe.newIgnitesMTD > 0) {
      data = data.replace(
        /{ label: "New Ignites MTD", value: "\d+", goal: 20, sub: "[^"]+", color: "[^"]+" }/,
        `{ label: "New Ignites MTD", value: "${stripe.newIgnitesMTD}", goal: 20, sub: "${Math.round(stripe.newIgnitesMTD/20*100)}% to goal · Stripe live ${todayDate}", color: "#12B76A" }`
      );
      console.log(`  ✅ New Ignites → ${stripe.newIgnitesMTD} (from Stripe)`);
    }
    if (stripe.arr > 0) {
      data = data.replace(
        /{ label: "Total ARR"[^}]+}/,
        `{ label: "Total ARR", value: "${stripe.arrStr}", goal: 100000, sub: "${stripe.apexCount} Apex teams · ${stripe.total} active subs · Stripe live", color: "#EE3135" }`
      );
      console.log(`  ✅ ARR → ${stripe.arrStr}`);
    }
  }

  // ── SendGrid ECE stats ──
  if (sendgrid && sendgrid.requests > 0) {
    const todayDate = today();
    // Update ECE kpis in data.js
    data = data.replace(
      /\{ label: "Sent", value: "[^"]+"/,
      `{ label: "Sent", value: "${sendgrid.requests.toLocaleString()}"`
    );
    data = data.replace(
      /\{ label: "Open Rate", value: "[^"]+"/,
      `{ label: "Open Rate", value: "${sendgrid.openRate}%"`
    );
    data = data.replace(
      /\{ label: "Delivery Rate", value: "[^"]+"/,
      `{ label: "Delivery Rate", value: "${sendgrid.deliveryRate}%"`
    );
    // Update funnel
    data = data.replace(
      /requests: \d+/,
      `requests: ${sendgrid.requests}`
    );
    data = data.replace(
      /delivered: \d+/,
      `delivered: ${sendgrid.delivered}`
    );
    data = data.replace(
      /opened: \d+/,
      `opened: ${sendgrid.opens}`
    );
    console.log(`  ✅ Email Engine → Sent: ${sendgrid.requests.toLocaleString()}, Open Rate: ${sendgrid.openRate}%, Delivered: ${sendgrid.deliveryRate}%`);
  }

  fs.writeFileSync('data.js', data);
  console.log('\n✅ data.js updated successfully');
}


// ─── SENDGRID ─────────────────────────────────────────────────────────────────
async function fetchSendGrid() {
  console.log('📧 Fetching SendGrid Email Engine stats...');
  try {
    const headers = {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    };

    // MTD date range
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const endDate = now.toISOString().split('T')[0];

    // Pull stats for the email-engine-prod subuser
    const res = await axios.get('https://api.sendgrid.com/v3/subusers/email-engine-prod/stats', {
      params: { start_date: startDate, end_date: endDate, aggregated_by: 'month' },
      headers
    });

    const stats = res.data && res.data[0] && res.data[0].stats && res.data[0].stats[0]
      ? res.data[0].stats[0].metrics
      : null;

    if (!stats) {
      console.log('  ⚠️ No SendGrid stats returned');
      return null;
    }

    const requests = stats.requests || 0;
    const delivered = stats.delivered || 0;
    const opens = stats.opens || 0;
    const bounces = stats.bounces || 0;

    const deliveryRate = requests > 0 ? ((delivered / requests) * 100).toFixed(2) : '0';
    const openRate = delivered > 0 ? ((opens / delivered) * 100).toFixed(2) : '0';

    console.log(`  ✅ Sent: ${requests.toLocaleString()}`);
    console.log(`  ✅ Delivered: ${delivered.toLocaleString()} (${deliveryRate}%)`);
    console.log(`  ✅ Opens: ${opens.toLocaleString()} (${openRate}%)`);
    console.log(`  ✅ Bounces: ${bounces}`);

    return { requests, delivered, opens, bounces, deliveryRate, openRate };
  } catch (e) {
    console.error('❌ SendGrid error:', e.message);
    return null;
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Duxre Dashboard Data Refresh — ' + today());
  console.log('==========================================\n');
  const [mixpanel, hubspot, stripe, sendgrid] = await Promise.all([
    fetchMixpanel(), fetchHubSpot(), fetchStripe(), fetchSendGrid()
  ]);
  await updateDataJs(mixpanel, hubspot, stripe, sendgrid);
  console.log('\n==========================================');
  console.log('✅ Refresh complete');
}

main().catch(e => { console.error('💥 Fatal:', e); process.exit(1); });
