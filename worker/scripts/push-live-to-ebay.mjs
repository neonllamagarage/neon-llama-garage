#!/usr/bin/env node
// =============================================================================
// ONE-OFF CATCH-UP SCRIPT: PUSH CURRENT LIVE UNSOLD CARS TO EBAY
// =============================================================================
// Usage:
//   1) Preview exact titles, galleries & policy-safe HTML (no credentials needed):
//      node worker/scripts/push-live-to-ebay.mjs --preview
//
//   2) Validate against eBay Production API without publishing (VerifyAddFixedPriceItem):
//      EBAY_ADMIN_SECRET="..." node worker/scripts/push-live-to-ebay.mjs --dry-run
//
//   3) Go LIVE (lists Quantity=1 @ $59.99 Free Shipping + schedules +18d ARCHIVE_SWEEP):
//      EBAY_ADMIN_SECRET="..." node worker/scripts/push-live-to-ebay.mjs --live
// =============================================================================

import {
  buildEbayTitle,
  selectOrderedEbayGallery,
  buildPolicySafeEbayHtml,
  createOrVerifyEbayListing,
} from "../src/index.js";

const API_BASE = process.env.NLG_API_BASE || "https://neonllamagarage.com";
const args = process.argv.slice(2);
const isPreview = args.includes("--preview") || args.length === 0;
const isLive = args.includes("--live");
const isDryRun = args.includes("--dry-run") || (!isPreview && !isLive);

async function main() {
  console.log(`\n🦙 Neon Llama Garage — One-Off eBay Catch-Up Tool`);
  console.log(`   Mode: ${isPreview ? "LOCAL PREVIEW" : isLive ? "🚀 LIVE PUBLISH" : "🧪 EBAY API DRY-RUN (VerifyAddFixedPriceItem)"}\n`);

  const feedResp = await fetch(`${API_BASE}/api/storefront-feed`);
  const feed = await feedResp.json();
  if (!feed.success) {
    throw new Error(`Failed to load storefront-feed: ${JSON.stringify(feed)}`);
  }

  const candidates = (feed.batches || []).filter(
    (b) => b.section === "active" && (parseInt(b.totalStock ?? 0, 10) || 0) > 0 && b.ebayStatus !== "ACTIVE"
  );

  if (candidates.length === 0) {
    console.log("✅ No unlisted active in-stock batches found.");
    return;
  }

  console.log(`Found ${candidates.length} active batch(es) ready for eBay Scarcity-Drip ($59.99 + Free Shipping, Qty=1):\n`);

  for (const b of candidates) {
    const title = buildEbayTitle(b);
    const gallery = selectOrderedEbayGallery(b);
    const html = buildPolicySafeEbayHtml(b);
    console.log(`----------------------------------------------------------------------`);
    console.log(`Batch:        ${b.id} — ${b.theme} (${b.model})`);
    console.log(`Reserve Stock:${b.totalStock} total units -> Listing 1 unit @ $59.99 + Free Shipping`);
    console.log(`eBay Title:   ${title}  [${title.length}/80 chars]`);
    console.log(`Hero Photo:   ${gallery[0] || "NONE"}`);
    console.log(`Gallery Pics: ${gallery.length} R2 HTTPS photos (Chase-only pics filtered out)`);
    console.log(`HTML Length:  ${html.length} chars (external URLs & raffle words stripped)`);
  }
  console.log(`----------------------------------------------------------------------\n`);

  if (isPreview) {
    console.log(`ℹ️  Preview complete. Once Worker v2.2 & eBay secrets are deployed, run with --dry-run then --live.`);
    return;
  }

  // If EBAY_CLIENT_ID + EBAY_CLIENT_SECRET + EBAY_REFRESH_TOKEN are passed locally in env,
  // we can also run VerifyAddFixedPriceItem directly from here BEFORE or via Worker!
  const secret = process.env.EBAY_ADMIN_SECRET || process.env.EBAY_CLIENT_SECRET || "";
  if (secret && !process.env.DIRECT_LOCAL_ONLY) {
    const resp = await fetch(`${API_BASE}/api/ebay/catchup-live`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Secret": secret,
      },
      body: JSON.stringify({ dryRun: !isLive }),
    });
    const out = await resp.json();
    console.log("Worker /api/ebay/catchup-live response:");
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Direct local eBay API execution fallback (if running directly with local env vars)
  if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_REFRESH_TOKEN) {
    for (const b of candidates) {
      const res = await createOrVerifyEbayListing(process.env, b, { dryRun: !isLive });
      console.log(`${b.id}:`, JSON.stringify(res, null, 2));
    }
    return;
  }

  console.error("❌ Set EBAY_ADMIN_SECRET (matching Worker EBAY_CLIENT_SECRET or EBAY_ADMIN_KEY) to execute --dry-run or --live.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
