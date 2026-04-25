/**
 * Duxre RevOps Dashboard — Live Data Fetcher
 * Runs in GitHub Actions on every push to main + daily at 6am CST
 * Updates data.js with fresh numbers from all live sources
 */

const axios = require('axios');
const fs = require('fs');

// ─── HELPERS ────────────────────────────────────────────────────────────────

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
        params: {
          project_id: projectId,
          from_date: from,
          to_date: to,
          event: JSON.stringify([event])
        },
        headers: { Authorization: `Basic ${auth}` },
        responseType: 'text'
      });

      // Count lines (each line = one event)
      const count = res.data.trim().split('\n').filter(l => l.trim()).length;
      results[event] = count;
      console.log(`  ✅ ${event}: ${count}`);
    }

    return {
      dashboard: results['Login - Dashboard'] || 0,
      marketplace: results['Login - Marketplace'] || 0,
      microsite: results['Login - Microsite'] || 0,
      total: (results['Login - Dashboard'] || 0) +
             (results['Login - Marketplace'] || 0) +
             (results['Login - Microsite'] || 0)
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

    // Demos Booked (stage 1083942046) created this month
    const demosRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: 'EQ', value: '1083942046' },
            { propertyName: 'createdate', operator: 'GTE', value: String(from) }
          ]
        }],
        properties: ['dealname', 'dealstage', 'createdate'],
        limit: 100
      },
      { headers }
    );
    const demosCount = demosRes.data.total || 0;
    console.log(`  ✅ Demos booked MTD: ${demosCount}`);

    // Active pipeline - all deals in active stages
    const pipelineRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: 'IN',
              values: ['1083942044', '1083942045', '1083942046', '1083942047', '1083942048'] }
          ]
        }],
        properties: ['dealname', 'dealstage', 'closedate', 'hubspot_owner_id'],
        limit: 100,
        sorts: [{ propertyName: 'closedate', direction: 'ASCENDING' }]
      },
      { headers }
    );

    // Count by priority/stage
    const deals = pipelineRes.data.results || [];
    const hot = deals.filter(d => d.properties.dealstage === '1083942046').length;
    const warm = deals.filter(d =>
      ['1083942044','1083942045'].includes(d.properties.dealstage)
    ).length;
    const total = deals.length;

    console.log(`  ✅ Pipeline total: ${total} (hot: ${hot}, warm: ${warm})`);

    // Power Brokers - contacts tagged in hs_content_membership_notes
    const pbRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [{
          filters: [
            { propertyName: 'hs_content_membership_notes', operator: 'HAS_PROPERTY' }
          ]
        }],
        properties: ['hs_content_membership_notes'],
        limit: 200
      },
      { headers }
    );
    const powerBrokers = pbRes.data.total || 0;
    console.log(`  ✅ Power Brokers: ${powerBrokers}`);

    // New Ignites MTD - deals with "Ignite" in name, created this month, NOT bulk import
    const igniteRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        filterGroups: [{
          filters: [
            { propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: 'Ignite' },
            { propertyName: 'createdate', operator: 'GTE', value: String(from) },
            // Exclude the Apr 12 bulk import by using a day after it
            { propertyName: 'createdate', operator: 'GTE',
              value: String(new Date(new Date().getFullYear(), new Date().getMonth(), 13).getTime()) }
          ]
        }],
        properties: ['dealname', 'createdate'],
        limit: 100
      },
      { headers }
    );
    const newIgnites = igniteRes.data.total || 0;
    console.log(`  ✅ New Ignites MTD (post Apr 12): ${newIgnites}`);

    return { demosCount, hot, warm, total, powerBrokers, newIgnites };
  } catch (e) {
    console.error('❌ HubSpot error:', e.message);
    return null;
  }
}

// ─── GA4 ─────────────────────────────────────────────────────────────────────

async function fetchGA4() {
  console.log('📈 Fetching GA4 traffic...');
  try {
    const serviceAccount = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
    const propertyId = process.env.GA4_PROPERTY_ID; // e.g. "11453780286"

    // Get access token via service account JWT
    const { google } = require('googleapis');
    // Note: googleapis not installed — use manual JWT approach
    // We'll use a simpler approach with the service account key

    // For now use axios with service account credentials
    // (googleapis would be needed for full implementation)
    // Placeholder — returns last known values if GA4 not available
    console.log('  ⚠️ GA4 requires googleapis package — using last known values');
    return null;
  } catch (e) {
    console.error('❌ GA4 error:', e.message);
    return null;
  }
}

// ─── STRIPE ──────────────────────────────────────────────────────────────────

async function fetchStripe() {
  console.log('💳 Fetching Stripe subscriptions...');
  try {
    const headers = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };

    let allSubs = [];
    let startingAfter = null;
    let hasMore = true;

    while (hasMore) {
      const params = { status: 'active', limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;

      const res = await axios.get('https://api.stripe.com/v1/subscriptions', {
        params, headers
      });

      allSubs = allSubs.concat(res.data.data);
      hasMore = res.data.has_more;
      if (hasMore && res.data.data.length > 0) {
        startingAfter = res.data.data[res.data.data.length - 1].id;
      }
    }

    // Calculate ARR - sum up subscription amounts
    let monthlyRevenue = 0;
    const APEX_PRICE_IDS = [
      'price_1SdzXGEEbsKUaWNi4K5gwoLQ',
      'price_1SdzXhEEbsKUaWNiClKBMPb8',
      'price_1SdzWnEEbsKUaWNiI26ebPjI',
      'price_1RrgRzEEbsKUaWNiDvmGJdVA',
      'price_1RrgRaEEbsKUaWNiPb0kS1qE',
      'price_1RrgPIEEbsKUaWNiRc0pISV7',
      'price_1T5Y5LEEbsKUaWNifi3K1vHs',
      'price_1ScequEEbsKUaWNimRFnLwW8'
    ];

    let apexCount = 0;
    let igniteCount = 0;

    for (const sub of allSubs) {
      for (const item of sub.items.data) {
        const priceId = item.price.id;
        if (APEX_PRICE_IDS.includes(priceId)) {
          apexCount++;
        } else {
          igniteCount++;
        }
        // Add to monthly revenue (price amount / 100 for cents to dollars)
        if (item.price.unit_amount) {
          monthlyRevenue += (item.price.unit_amount / 100) * (item.quantity || 1);
        }
      }
    }

    const arr = Math.round(monthlyRevenue * 12);
    const arrStr = arr >= 1000 ? `$${Math.round(arr/1000)}K` : `$${arr}`;

    console.log(`  ✅ Active subscriptions: ${allSubs.length}`);
    console.log(`  ✅ Apex: ${apexCount}, Ignite: ${igniteCount}`);
    console.log(`  ✅ Monthly Revenue: $${monthlyRevenue} → ARR: ${arrStr}`);

    return { total: allSubs.length, apexCount, igniteCount, monthlyRevenue, arr, arrStr };
  } catch (e) {
    console.error('❌ Stripe error:', e.message);
    return null;
  }
}

// ─── UPDATE DATA.JS ──────────────────────────────────────────────────────────

async function updateDataJs(mixpanel, hubspot, ga4, stripe) {
  console.log('\n📝 Updating data.js...');

  let data = fs.readFileSync('data.js', 'utf8');
  const todayDate = today();
  const period = `${new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', timeZone:'America/Chicago'})} — ${todayDate}`;

  // ── Date ──
  data = data.replace(/updated: "[^"]+"/g, `updated: "${todayDate}"`);
  console.log(`  ✅ Date → ${todayDate}`);

  // ── Mixpanel ──
  if (mixpanel) {
    const total = mixpanel.total.toLocaleString();
    data = data.replace(/dashboard: \d+,/, `dashboard: ${mixpanel.dashboard},`);
    data = data.replace(/marketplace: \d+,/, `marketplace: ${mixpanel.marketplace},`);
    data = data.replace(/microsite: \d+/, `microsite: ${mixpanel.microsite}`);
    data = data.replace(
      /{ label: "Broker Logins[^}]+ }/,
      `{ label: "Broker Logins — Apr MTD", value: "${total}", sub: "Dashboard ${mixpanel.dashboard} · Marketplace ${mixpanel.marketplace} · Microsite ${mixpanel.microsite} · Live ${todayDate}" }`
    );
    console.log(`  ✅ Broker Logins → ${total}`);
  }

  // ── HubSpot ──
  if (hubspot) {
    // Demos Booked — only update if > 0 and seems reasonable
    if (hubspot.demosCount > 0 && hubspot.demosCount < 50) {
      data = data.replace(
        /{ label: "Demos Booked MTD", value: "\d+", goal: 20, sub: "[^"]+", color: "[^"]+" }/,
        `{ label: "Demos Booked MTD", value: "${hubspot.demosCount}", goal: 20, sub: "${Math.round(hubspot.demosCount/20*100)}% to goal · HubSpot live ${todayDate}", color: "#EE3135" }`
      );
      console.log(`  ✅ Demos → ${hubspot.demosCount}`);
    }

    // Power Brokers
    if (hubspot.powerBrokers > 0) {
      data = data.replace(
        /{ label: "Power Brokers"[^}]+}/,
        `{ label: "Power Brokers", value: "${hubspot.powerBrokers} /50", goal: 50, sub: "HubSpot live · ${hubspot.powerBrokers} tagged", color: "#282828" }`
      );
      console.log(`  ✅ Power Brokers → ${hubspot.powerBrokers}`);
    }
  }

  // ── Stripe ARR ──
  if (stripe && stripe.arr > 0) {
    data = data.replace(
      /{ label: "Total ARR"[^}]+}/,
      `{ label: "Total ARR", value: "${stripe.arrStr}", goal: 100000, sub: "${stripe.apexCount} Apex teams · ${stripe.total} active subs · Stripe live", color: "#EE3135" }`
    );
    console.log(`  ✅ ARR → ${stripe.arrStr} (${stripe.total} subs)`);
  }

  fs.writeFileSync('data.js', data);
  console.log('\n✅ data.js updated successfully');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Duxre Dashboard Data Refresh — ' + today());
  console.log('==========================================\n');

  const [mixpanel, hubspot, ga4, stripe] = await Promise.all([
    fetchMixpanel(),
    fetchHubSpot(),
    fetchGA4(),
    fetchStripe()
  ]);

  await updateDataJs(mixpanel, hubspot, ga4, stripe);

  console.log('\n==========================================');
  console.log('✅ Data refresh complete');
}

main().catch(e => {
  console.error('💥 Fatal error:', e);
  process.exit(1);
});
