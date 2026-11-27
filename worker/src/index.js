const LEGACY_GAS_EMAIL_RELAY =
  "https://script.google.com/macros/s/AKfycbxe1WwM8zoYYR1aU4N2EcsqvAjh0PXgVzPwIh1ZnwaB4YYdfwI-fd8eJysx37lgMplHwQ/exec";

export default {
  // ===========================================================================
  // 15-MINUTE AUTONOMOUS CHRONOS & VISION 2.0 SCHEDULER (CLOUDFLARE CRON)
  // ===========================================================================
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processChronosQueue(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const jsonResp = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    // -------------------------------------------------------------------------
    // 0. HEALTH & CAPABILITIES CHECK
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/health" || url.pathname === "/api") {
      return jsonResp({
        status: "ok",
        service: "Neon Llama Single-Source Studio & Chronos Engine v2.1",
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        kvConfigured: Boolean(env.NLG_DB),
        r2Configured: Boolean(env.MEDIA_BUCKET),
        stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
        makeConfigured: Boolean(env.MAKE_WEBHOOK_URL),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        gasEmailRelay: true,
        vision2Sweep: true,
        timestamp: new Date().toISOString(),
      });
    }

    // -------------------------------------------------------------------------
    // 1. PUBLIC STOREFRONT & STUDIO SSoT FEED (GET /api/storefront-feed)
    //    Also opportunistically ticks Chronos in background as a backup pulse!
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/storefront-feed" && request.method === "GET") {
      try {
        if (!env.NLG_DB) {
          return jsonResp({ success: false, error: "NLG_DB KV namespace not bound yet" }, 503);
        }
        ctx.waitUntil(processChronosQueue(env));

        const raw = await env.NLG_DB.get("batches_v1", "json");
        const allBatches = Array.isArray(raw) ? raw : [];
        const includeAll = url.searchParams.get("scope") === "studio";
        const filtered = includeAll
          ? allBatches
          : allBatches.filter(
              (b) => b.section === "active" || b.section === "vault" || b.status === "Ready" || b.status === "Sold"
            );

        return jsonResp({ success: true, batches: filtered, updatedAt: new Date().toISOString() });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // 2. SAVE / SYNC STUDIO FLEET STATE TO SSoT KV (POST /api/sync-batches)
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/sync-batches" && request.method === "POST") {
      try {
        if (!env.NLG_DB) return jsonResp({ success: false, error: "NLG_DB KV not bound" }, 503);
        const body = await request.json();
        if (!Array.isArray(body.batches)) return jsonResp({ success: false, error: "batches array required" }, 400);
        await env.NLG_DB.put("batches_v1", JSON.stringify(body.batches));
        return jsonResp({ success: true, count: body.batches.length });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // 3. UPLOAD FINAL STOREFRONT / REEL MEDIA ONLY TO R2 (/api/upload-r2)
    //    Supports raw binary stream (?key=foo.mp4) OR JSON { key, base64/sourceUrl }
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/upload-r2" && (request.method === "POST" || request.method === "PUT")) {
      try {
        if (!env.MEDIA_BUCKET) return jsonResp({ success: false, error: "MEDIA_BUCKET R2 not bound" }, 503);
        const queryKey = url.searchParams.get("key");
        if (queryKey) {
          const safeKey = String(queryKey).replace(/[^a-zA-Z0-9._-]/g, "_");
          const ct = request.headers.get("content-type") || (safeKey.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
          await env.MEDIA_BUCKET.put(safeKey, request.body, { httpMetadata: { contentType: ct } });
          return jsonResp({ success: true, key: safeKey, url: `https://media.neonllamagarage.com/${safeKey}` });
        }

        const body = await request.json();
        const key = String(body.key || "").replace(/[^a-zA-Z0-9._-]/g, "_");
        if (!key) return jsonResp({ success: false, error: "Missing key" }, 400);

        let bytes;
        let contentType = body.mimeType || "image/jpeg";

        if (body.base64) {
          const rawB64 = body.base64.includes(",") ? body.base64.split(",")[1] : body.base64;
          bytes = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0));
        } else if (body.sourceUrl) {
          const srcResp = await fetch(body.sourceUrl);
          if (!srcResp.ok) throw new Error(`Failed to fetch sourceUrl (${srcResp.status})`);
          contentType = srcResp.headers.get("content-type") || contentType;
          bytes = await srcResp.arrayBuffer();
        } else {
          return jsonResp({ success: false, error: "Provide base64 or sourceUrl" }, 400);
        }

        await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
        return jsonResp({ success: true, key, url: `https://media.neonllamagarage.com/${key}` });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // 4. 1-CLICK DEPLOY DROP + DRIVE->R2 PROMOTION + STRIPE + CHRONOS SCHEDULE
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/deploy-drop" && request.method === "POST") {
      try {
        if (!env.NLG_DB) return jsonResp({ success: false, error: "NLG_DB KV not bound" }, 503);
        const payload = await request.json();
        const batchId = payload.id;
        if (!batchId) return jsonResp({ success: false, error: "Missing batch id" }, 400);

        const totalStock = Math.max(1, parseInt(payload.totalStock ?? payload.plannedTotal ?? 10, 10));
        const plannedTotal = Math.max(totalStock, parseInt(payload.plannedTotal ?? totalStock, 10));
        const plannedChase = parseInt(payload.plannedChase ?? 0, 10);
        const priceUsd = parseFloat(payload.price || 50);
        const title = payload.title || `Neon Llama Garage "${payload.theme}" ${payload.model} Custom 1/64`;

        // Auto-promote ONLY final storefront IMG_* photos from Google Drive to R2 on launch
        const cleanSlug = `${payload.theme || "Custom"}_${payload.model || "Car"}`.replace(/[^a-zA-Z0-9]+/g, "_");
        const pa = payload.pipelineAssets || {};
        const promoTags = [
          "IMG_LOOSE", "IMG_PKG_F", "IMG_PKG_R", "IMG_PKG_WHT", "IMG_TOP",
          "IMG_DCL_CU", "IMG_PKG_CU", "IMG_CHASE_L", "IMG_CHASE_P", "IMG_SET_P", "IMG_SET_L", "IMG_GROUP", "IMG_PKG_GRP",
        ];
        const candidatePhotos = [];
        for (const t of promoTags) {
          const vals = Array.isArray(pa[t]) ? pa[t] : pa[t] ? [pa[t]] : [];
          for (let idx = 0; idx < vals.length; idx++) {
            if (vals[idx]) candidatePhotos.push({ tag: t, idx, url: vals[idx] });
          }
        }
        if (Array.isArray(payload.images)) {
          payload.images.forEach((u, i) => {
            if (u && !candidatePhotos.some((c) => c.url === u)) candidatePhotos.push({ tag: "IMG_OTHER", idx: i, url: u });
          });
        }

        const r2Gallery = [];
        let promotedHero = payload.heroImg || payload.hero || "";
        for (const item of candidatePhotos) {
          if (item.url.startsWith("https://media.neonllamagarage.com/")) {
            if (!r2Gallery.includes(item.url)) r2Gallery.push(item.url);
            if (item.tag === "IMG_LOOSE" && !promotedHero.startsWith("https://media.")) promotedHero = item.url;
          } else if (env.MEDIA_BUCKET && item.url.includes("drive.google.com/thumbnail")) {
            try {
              const hiResUrl = item.url.replace(/sz=w\d+/, "sz=w1600");
              const imgResp = await fetch(hiResUrl);
              if (imgResp.ok && (imgResp.headers.get("content-type") || "").startsWith("image/")) {
                const key = `${cleanSlug}_${item.tag}_${item.idx + 1}.jpg`;
                await env.MEDIA_BUCKET.put(key, await imgResp.arrayBuffer(), {
                  httpMetadata: { contentType: imgResp.headers.get("content-type") || "image/jpeg" },
                });
                const pubUrl = `https://media.neonllamagarage.com/${key}`;
                if (!r2Gallery.includes(pubUrl)) r2Gallery.push(pubUrl);
                if (item.tag === "IMG_LOOSE") promotedHero = pubUrl;
              }
            } catch (_) {}
          }
        }
        const finalImages = r2Gallery.length > 0 ? r2Gallery : payload.images || [];
        const finalHero = promotedHero || finalImages[0] || payload.hero || "";

        // Auto-create Hard-Capped Stripe Payment Link if none supplied
        let stripeLink = (payload.stripeLink || "").trim();
        if ((!stripeLink || payload.forceNewStripeLink) && env.STRIPE_SECRET_KEY) {
          stripeLink = await createHardCappedStripePaymentLink(env.STRIPE_SECRET_KEY, {
            batchId,
            title,
            priceUsd,
            maxUnits: totalStock,
            heroImg: finalHero,
          });
        }

        // Provably Fair Chase SHA-256 Commitment (matches legacy Pike-XXXX Salt + Win_Num + Hash)
        let chaseWinNum = payload.winNum || null;
        let chaseSalt = payload.salt || null;
        let chaseHash = payload.chaseHash || null;
        if (plannedChase > 0 && !chaseHash) {
          const randArr = new Uint32Array(2);
          crypto.getRandomValues(randArr);
          chaseWinNum = (randArr[0] % plannedTotal) + 1;
          chaseSalt = "Pike-" + randArr[1].toString(16).toUpperCase().padStart(8, "0");
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`Winning Unit #${chaseWinNum} | Salt: ${chaseSalt}`)
          );
          chaseHash = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        }

        const launchMs = payload.launchDate ? new Date(payload.launchDate).getTime() : Date.now() + 72 * 3600 * 1000;
        const launchIso = new Date(launchMs).toISOString();

        // Update batches_v1 in KV
        const existingBatches = (await env.NLG_DB.get("batches_v1", "json")) || [];
        let found = false;
        const updatedBatches = existingBatches.map((b) => {
          if (b.id !== batchId) return b;
          found = true;
          return {
            ...b,
            ...payload,
            section: "active",
            status: "Ready",
            totalStock,
            plannedTotal,
            plannedChase,
            winNum: chaseWinNum ?? b.winNum,
            salt: chaseSalt ?? b.salt,
            chaseHash: chaseHash ?? b.chaseHash,
            price: priceUsd,
            minPrice: priceUsd,
            title,
            stripeLink,
            launchDate: launchIso,
            lastPromoAt: launchIso,
            images: finalImages,
            heroImg: finalHero,
            hero: finalHero,
            socialCopy: payload.socialCopy || b.socialCopy || {},
          };
        });
        if (!found) {
          updatedBatches.unshift({
            ...payload,
            section: "active",
            status: "Ready",
            totalStock,
            plannedTotal,
            plannedChase,
            price: priceUsd,
            minPrice: priceUsd,
            title,
            stripeLink,
            launchDate: launchIso,
            lastPromoAt: launchIso,
            images: finalImages,
            heroImg: finalHero,
            hero: finalHero,
          });
        }
        await env.NLG_DB.put("batches_v1", JSON.stringify(updatedBatches));

        // Compile Chronos Social Auto-Post Schedule into schedule_v1 KV
        const existingSchedule = ((await env.NLG_DB.get("schedule_v1", "json")) || []).filter(
          (ev) => !(ev.batchId === batchId && ev.status === "PENDING")
        );

        const sc = payload.socialCopy || {};
        const newEvents = [
          {
            id: `EVT-${batchId}-TEASER`,
            batchId,
            theme: payload.theme,
            model: payload.model,
            phase: "TEASER",
            scheduledAt: new Date(launchMs - 72 * 3600 * 1000).toISOString(),
            status: "PENDING",
            mediaUrl: payload.teaserVideoUrl || finalHero,
            copy: sc.teaser || {},
          },
          {
            id: `EVT-${batchId}-PROCESS`,
            batchId,
            theme: payload.theme,
            model: payload.model,
            phase: "PROCESS",
            scheduledAt: new Date(launchMs - 48 * 3600 * 1000).toISOString(),
            status: "PENDING",
            mediaUrl: payload.processVideoUrl || payload.teaserVideoUrl || finalHero,
            copy: sc.process || sc.teaser || {},
          },
          {
            id: `EVT-${batchId}-REVEAL`,
            batchId,
            theme: payload.theme,
            model: payload.model,
            phase: "REVEAL",
            scheduledAt: new Date(launchMs - 24 * 3600 * 1000).toISOString(),
            status: "PENDING",
            mediaUrl: payload.revealVideoUrl || finalHero,
            copy: sc.reveal || {},
          },
          {
            id: `EVT-${batchId}-VIP`,
            batchId,
            theme: payload.theme,
            model: payload.model,
            phase: "T-1h_VIP",
            scheduledAt: new Date(launchMs - 1 * 3600 * 1000).toISOString(),
            status: "PENDING",
            stripeLink,
            title,
            heroImg: finalHero,
          },
          {
            id: `EVT-${batchId}-LAUNCH`,
            batchId,
            theme: payload.theme,
            model: payload.model,
            phase: "OMNI_LAUNCH",
            scheduledAt: launchIso,
            status: "PENDING",
            mediaUrl: payload.launchVideoUrl || finalHero,
            stripeLink,
            copy: sc.launch || {},
          },
          {
            id: `EVT-${batchId}-MARKETPLACE`,
            batchId,
            theme: payload.theme,
            model: payload.model,
            phase: "MARKETPLACE_SYNC",
            scheduledAt: new Date(launchMs + 72 * 3600 * 1000).toISOString(),
            status: "PENDING",
            price: priceUsd,
            copy: sc.launch || {},
          },
          {
            id: `EVT-${batchId}-ARCHIVE`,
            batchId,
            theme: payload.theme,
            model: payload.model,
            phase: "ARCHIVE_SWEEP",
            scheduledAt: new Date(launchMs + 18 * 24 * 3600 * 1000).toISOString(),
            status: "PENDING",
          },
        ];

        const mergedSchedule = [...existingSchedule, ...newEvents].sort(
          (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
        );
        await env.NLG_DB.put("schedule_v1", JSON.stringify(mergedSchedule));

        ctx.waitUntil(
          sendTelegramAlert(
            env,
            `🚀 *DROP ARMED IN CHRONOS*\n*${batchId}: ${payload.theme} (${payload.model})*\n• Stock: ${totalStock} (${plannedChase} Chase) @ $${priceUsd}\n• Launch: ${new Date(launchMs).toUTCString()}\n• Stripe: ${stripeLink || "Manual"}\n• 7 Lifecycle & Social Events Queued`
          )
        );

        return jsonResp({ success: true, batchId, stripeLink, heroImg: finalHero, scheduledEvents: newEvents });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // 5. LIVE CHRONOS TIMELINE & MANUAL TRIGGER
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/chronos-timeline" && request.method === "GET") {
      if (!env.NLG_DB) return jsonResp({ success: false, alerts: [], timeline: [] });
      const schedule = (await env.NLG_DB.get("schedule_v1", "json")) || [];
      const alerts = schedule.filter((e) => e.status === "FAILED");
      return jsonResp({ success: true, alerts, timeline: schedule });
    }

    if (url.pathname === "/api/chronos-run-now" && request.method === "POST") {
      const report = await processChronosQueue(env);
      return jsonResp({ success: true, ...report });
    }

    // -------------------------------------------------------------------------
    // 6. CRM WAITLIST / CONTACT (SAVES TO KV + TELEGRAM + SILENT GAS GMAIL RELAY!)
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/crm" && request.method === "POST") {
      try {
        const body = await request.json();
        if (env.NLG_DB) {
          const list = (await env.NLG_DB.get("crm_v1", "json")) || [];
          if (body.email && !list.some((x) => String(x.email).toLowerCase() === String(body.email).toLowerCase())) {
            list.push({ ...body, createdAt: new Date().toISOString() });
            await env.NLG_DB.put("crm_v1", JSON.stringify(list));
          }
        }
        // Silently relay to existing GAS Gmail node so Welcome / Contact emails keep firing from neonllamagarage@gmail.com!
        ctx.waitUntil(
          fetch(LEGACY_GAS_EMAIL_RELAY, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(body),
          }).catch(() => {})
        );
        ctx.waitUntil(
          sendTelegramAlert(
            env,
            `📬 *NEW ${String(body.type || "CRM").toUpperCase()}*\n• Email: ${body.email || "N/A"}\n• Car/Msg: ${body.batchId || body.message || "VIP List"}`
          )
        );
        return jsonResp({ success: true });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    // -------------------------------------------------------------------------
    // 7. STRIPE WEBHOOK (METADATA + LEGACY LINK/TITLE FALLBACK + SOLD-OUT POST!)
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      try {
        const evt = await request.json();
        if (evt.type === "checkout.session.completed" && env.NLG_DB) {
          const session = evt.data?.object || {};
          const batches = (await env.NLG_DB.get("batches_v1", "json")) || [];

          let batchId = session.metadata?.batchId || "";
          let qtyBought = parseInt(session.metadata?.qty || "1", 10) || 1;

          // Fallback A: Match legacy buy.stripe.com Payment Link ID via Stripe API!
          if (!batchId && session.payment_link && env.STRIPE_SECRET_KEY) {
            try {
              const plResp = await fetch(`https://api.stripe.com/v1/payment_links/${session.payment_link}`, {
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
              });
              if (plResp.ok) {
                const plData = await plResp.json();
                const plUrl = plData.url || "";
                const metaId = plData.metadata?.batchId;
                if (metaId) {
                  batchId = metaId;
                } else if (plUrl) {
                  const byUrl = batches.find((b) => b.stripeLink && b.stripeLink.split("?")[0] === plUrl.split("?")[0]);
                  if (byUrl) batchId = byUrl.id;
                }
              }
            } catch (_) {}
          }

          // Fallback B: Match Checkout Session line_items product name against batch theme/model!
          if (!batchId && session.id && env.STRIPE_SECRET_KEY) {
            try {
              const liResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session.id}/line_items`, {
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
              });
              if (liResp.ok) {
                const liData = await liResp.json();
                const firstItem = liData.data?.[0];
                if (firstItem?.quantity) qtyBought = firstItem.quantity;
                const desc = String(firstItem?.description || "").toLowerCase();
                if (desc) {
                  const byTitle = batches.find(
                    (b) =>
                      (b.title && desc.includes(b.title.toLowerCase().slice(0, 18))) ||
                      (b.theme && b.model && desc.includes(b.theme.toLowerCase()) && desc.includes(b.model.replace(/'/g, "").toLowerCase().split(" ").pop()))
                  );
                  if (byTitle) batchId = byTitle.id;
                }
              }
            } catch (_) {}
          }

          if (batchId) {
            let soldBatch = null;
            let remaining = 0;
            const updated = batches.map((b) => {
              if (b.id !== batchId) return b;
              remaining = Math.max(0, (parseInt(b.totalStock ?? 1, 10) || 1) - qtyBought);
              const isSoldOut = remaining <= 0;
              soldBatch = {
                ...b,
                totalStock: remaining,
                section: isSoldOut ? "vault" : b.section,
                status: isSoldOut ? "Sold" : b.status,
                qty: isSoldOut ? "0 Available (Vaulted)" : `${remaining} In Stock`,
                soldOutAt: isSoldOut ? new Date().toISOString() : b.soldOutAt,
              };
              return soldBatch;
            });

            await env.NLG_DB.put("batches_v1", JSON.stringify(updated));

            if (soldBatch) {
              const buyerEmail = session.customer_details?.email || session.customer_email || "Collector";
              ctx.waitUntil(
                sendTelegramAlert(
                  env,
                  `💰 *SALE CONFIRMED!* (${soldBatch.id})\n*${soldBatch.theme} — ${soldBatch.model}*\n• Buyer: ${buyerEmail} (Qty: ${qtyBought})\n• Remaining Stock: *${remaining}*${remaining <= 0 ? "\n🏛️ *SOLD OUT — AUTO-MOVED TO THE VAULT & SSoT UPDATED!*" : ""}`
                )
              );

              // Vision 2.0 Rule: Auto-fire SOLD OUT celebration post to Make.com when stock hits 0!
              if (remaining <= 0 && env.MAKE_WEBHOOK_URL) {
                const soldOutText = `🏛️ OFFICIALLY SOLD OUT! Every single 1-of-${soldBatch.plannedTotal || 10} "${soldBatch.theme}" ${soldBatch.model} has been claimed and locked in The Vault forever. Huge thank you to our collectors—make sure you're on the VIP list at neonllamagarage.com so you don't miss Friday's drop! 🦙🔥 #neonllamagarage #soldout #hotwheelscustom`;
                ctx.waitUntil(
                  fetch(env.MAKE_WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      eventId: `EVT-${soldBatch.id}-SOLDOUT-${Date.now()}`,
                      batchId: soldBatch.id,
                      theme: soldBatch.theme,
                      model: soldBatch.model,
                      phase: "SOLD_OUT",
                      postType: 5,
                      mediaType: "image",
                      mediaUrl: soldBatch.heroImg || soldBatch.hero || "",
                      storeUrl: "https://neonllamagarage.com",
                      copy: { ig: soldOutText, fb: soldOutText, x: soldOutText.slice(0, 275), tt: soldOutText },
                    }),
                  }).catch(() => {})
                );
              }
            }
          } else {
            ctx.waitUntil(
              sendTelegramAlert(
                env,
                `💳 *STRIPE SALE RECEIVED*\nSession ${session.id || ""} completed ($${((session.amount_total || 0) / 100).toFixed(2)}), but could not match batchId.`
              )
            );
          }
        }
        return jsonResp({ received: true });
      } catch (err) {
        return jsonResp({ error: err.message }, 400);
      }
    }

    // -------------------------------------------------------------------------
    // GEMINI AI ENDPOINTS
    // -------------------------------------------------------------------------
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResp({ error: "GEMINI_API_KEY secret is not configured on the Cloudflare Worker." }, 500);
    }

    // 8. 3-PHASE OMNICHANNEL SOCIAL COPY & COLLECTOR STORY GENERATOR
    if (url.pathname === "/api/generate-social-copy" && request.method === "POST") {
      try {
        const body = await request.json();
        const { theme = "Custom", model = "Hot Wheels", color = "Custom", plannedTotal = 10, plannedChase = 0, price = 50 } = body;

        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `You are the hype-driven collector brand voice for Neon Llama Garage (a father-son custom 1/64 Hot Wheels studio in Utah & Texas).
Generate complete launch copy for our custom 1:64 "${theme}" ${model} (${color} finish, Real Rider rubber wheels, bespoke blister card, limited run of ${plannedTotal} numbered units${plannedChase > 0 ? ` including ${plannedChase} ultra-rare Chase variant` : ""}, $${price} MSRP at neonllamagarage.com).

Return ONLY valid JSON with this exact structure:
{
  "title": "SEO collector product title (max 75 chars)",
  "desc": "<p>2-3 rich HTML paragraphs telling the collector story, craftsmanship, Real Riders, and limited edition scarcity</p>",
  "tags": "10 comma-separated SEO keywords",
  "socialCopy": {
    "teaser": { "ig": "T-72h moody macro teaser caption w/ hashtags", "fb": "FB teaser post", "x": "Punchy X teaser (<260 chars)", "tt": "TikTok hook caption", "ytTitle": "YT Shorts Teaser Title (<70 chars)", "ytDesc": "YT Shorts description" },
    "reveal": { "ig": "T-24h full 360 reveal + blister card drop tomorrow 7PM caption", "fb": "FB reveal post", "x": "X 24h reveal (<260 chars)", "tt": "TikTok reveal caption", "ytTitle": "YT Shorts Reveal Title (<70 chars)", "ytDesc": "YT Shorts reveal description" },
    "launch": { "ig": "LIVE NOW in the Vault! Link in bio / neonllamagarage.com caption", "fb": "FB LIVE NOW launch post with neonllamagarage.com", "x": "X LIVE NOW post (<260 chars)", "tt": "TikTok LIVE NOW caption", "ytTitle": "YT Shorts Launch Title (<70 chars)", "pinTitle": "Pinterest Pin Title", "pinDesc": "Pinterest SEO description" }
  }
}`
                }]
              }],
              generationConfig: { responseMimeType: "application/json" },
            }),
          }
        );

        if (!resp.ok) {
          const t = await resp.text();
          return jsonResp({ success: false, error: `Gemini ${resp.status}: ${t.slice(0, 200)}` }, 500);
        }
        const gData = await resp.json();
        const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const cleaned = rawText.replace(/```json/gi, "").replace(/```/gi, "").trim();
        return jsonResp({ success: true, ...JSON.parse(cleaned) });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    async function callGeminiImage(prompt, referenceImages = [], aspectRatio = null) {
      const parts = [{ text: prompt }];
      for (const imgData of referenceImages) {
        if (typeof imgData === "string" && imgData.startsWith("data:image/")) {
          const match = imgData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }
      const generationConfig = { responseModalities: ["TEXT", "IMAGE"] };
      if (aspectRatio && typeof aspectRatio === "string") generationConfig.imageConfig = { aspectRatio };

      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }], generationConfig }),
        }
      );
      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, status: resp.status, error: `Gemini API ${resp.status}: ${errText.slice(0, 300)}` };
      }
      const data = await resp.json();
      for (const cand of data.candidates || []) {
        for (const p of cand.content?.parts || []) {
          if (p.inlineData?.data) {
            const mime = p.inlineData.mimeType || "image/png";
            return { ok: true, image: `data:${mime};base64,${p.inlineData.data}` };
          }
        }
      }
      return { ok: false, status: 500, error: "Gemini returned no image payload." };
    }

    // 9. GENERATE 8 CUSTOM CONCEPTS
    if (url.pathname === "/api/generate-concepts" && request.method === "POST") {
      try {
        const body = await request.json();
        const casting = body.casting || "Hot Wheels Custom";
        const paint = body.paint || "Gloss White";
        const notes = body.notes || "Real Riders";

        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `You are the lead custom 1:64 Hot Wheels diecast UV-printer livery designer for Neon Llama Garage.
Generate 8 wildly creative, distinct, collector-grade custom DECAL / TAMPO livery concepts for a 1:64 scale "${casting}" with "${paint}" base paint and "${notes}".
CRITICAL MANUFACTURING RULE: These graphics will be printed on a flatbed UV printer ONLY onto the FLAT side panels and FLAT roof panel. NEVER design a 100% full-car wrap or all-over background cover. Every single concept MUST be a crisp, self-contained flat-panel graphic/tampo design that lets the "${paint}" base paint show cleanly around the front nose, pillars, and edges.
Return ONLY a valid JSON array of exactly 8 objects with keys: "title", "badge", "desc", "primary", "accent", "style".`
                }]
              }],
              generationConfig: { responseMimeType: "application/json" },
            }),
          }
        );

        if (resp.ok) {
          const gData = await resp.json();
          const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const cleaned = rawText.replace(/```json/gi, "").replace(/```/gi, "").trim();
          const startIdx = cleaned.indexOf("[");
          const endIdx = cleaned.lastIndexOf("]");
          if (startIdx !== -1 && endIdx !== -1) {
            const parsed = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
            if (Array.isArray(parsed) && parsed.length >= 8) return jsonResp(parsed.slice(0, 8));
          }
        }
        return jsonResp({ error: "Failed to parse 8 concepts" }, 500);
      } catch (err) {
        return jsonResp({ error: err.message }, 500);
      }
    }

    // 10. GENERATE IMAGE VIA GEMINI 3.1 FLASH IMAGE
    if (url.pathname === "/api/generate-image" && request.method === "POST") {
      try {
        const body = await request.json();
        const prompt = body.prompt;
        const referenceImages = Array.isArray(body.referenceImages) ? body.referenceImages : [];
        const aspectRatio = typeof body.aspectRatio === "string" ? body.aspectRatio : null;
        if (!prompt) return jsonResp({ error: "Missing prompt" }, 400);

        const result = await callGeminiImage(prompt, referenceImages, aspectRatio);
        if (!result.ok) return jsonResp({ error: result.error }, result.status || 500);
        return jsonResp({ success: true, engine: "gemini-3.1-flash-image", image: result.image });
      } catch (err) {
        return jsonResp({ error: err.message || "Gemini image generation failed" }, 500);
      }
    }

    return jsonResp({ error: "Endpoint not found" }, 404);
  },
};

// =============================================================================
// HELPER: CREATE HARD-CAPPED STRIPE PAYMENT LINK
// =============================================================================
async function createHardCappedStripePaymentLink(stripeKey, { batchId, title, priceUsd, maxUnits, heroImg }) {
  const formEncode = (obj) =>
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

  const headers = {
    Authorization: `Bearer ${stripeKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const prodBody = { name: title, "metadata[batchId]": batchId };
  if (heroImg && heroImg.startsWith("https://")) prodBody["images[0]"] = heroImg;

  const prodResp = await fetch("https://api.stripe.com/v1/products", {
    method: "POST",
    headers,
    body: formEncode(prodBody),
  });
  const prod = await prodResp.json();
  if (!prodResp.ok) throw new Error(`Stripe Product Error: ${prod.error?.message || prodResp.status}`);

  const priceResp = await fetch("https://api.stripe.com/v1/prices", {
    method: "POST",
    headers,
    body: formEncode({ product: prod.id, unit_amount: Math.round(priceUsd * 100), currency: "usd" }),
  });
  const price = await priceResp.json();
  if (!priceResp.ok) throw new Error(`Stripe Price Error: ${price.error?.message || priceResp.status}`);

  const linkResp = await fetch("https://api.stripe.com/v1/payment_links", {
    method: "POST",
    headers,
    body: formEncode({
      "line_items[0][price]": price.id,
      "line_items[0][quantity]": 1,
      "restrictions[completed_sessions][limit]": maxUnits,
      "shipping_address_collection[allowed_countries][0]": "US",
      "metadata[batchId]": batchId,
      "after_completion[type]": "redirect",
      "after_completion[redirect][url]": "https://neonllamagarage.com/?purchased=" + encodeURIComponent(batchId),
    }),
  });
  const link = await linkResp.json();
  if (!linkResp.ok) throw new Error(`Stripe PaymentLink Error: ${link.error?.message || linkResp.status}`);
  return link.url;
}

// =============================================================================
// HELPER: PROCESS CHRONOS QUEUE + VISION 2.0 WEEKLY RELAUNCH & THROWBACK SWEEP
// =============================================================================
async function processChronosQueue(env) {
  if (!env.NLG_DB) return { processed: 0 };
  const now = Date.now();

  // Throttle check so opportunistic HTTP pulses don't hammer KV more than once per 5 min
  const lastPulse = parseInt((await env.NLG_DB.get("chronos_last_pulse")) || "0", 10);
  if (now - lastPulse < 5 * 60 * 1000) return { processed: 0, skippedThrottle: true };
  await env.NLG_DB.put("chronos_last_pulse", String(now));

  const batches = (await env.NLG_DB.get("batches_v1", "json")) || [];
  let schedule = (await env.NLG_DB.get("schedule_v1", "json")) || [];
  let batchesChanged = false;
  let scheduleChanged = false;

  // ---------------------------------------------------------------------------
  // A. VISION 2.0 WEEKLY SWEEP (4-Month Unsold Relaunch + 6-Month Vault Throwback)
  //    Rules from Vision2.0 sheet:
  //    • New launches ALWAYS take priority
  //    • Max 2 events/week, max 1 relaunch/week (Friday or Monday 7PM)
  //    • 4-month (120d) threshold if totalStock > 0 -> Mini-Relaunch (Reveal -24h + Go Live)
  //    • 6-month (180d) threshold if totalStock == 0 -> "Remember When" Vault Flashback
  // ---------------------------------------------------------------------------
  const lastSweep = parseInt((await env.NLG_DB.get("vision_last_sweep")) || "0", 10);
  if (now - lastSweep > 24 * 3600 * 1000) {
    await env.NLG_DB.put("vision_last_sweep", String(now));
    const twoWeeksAhead = now + 14 * 24 * 3600 * 1000;
    const upcomingCount = schedule.filter((e) => e.status === "PENDING" && new Date(e.scheduledAt).getTime() <= twoWeeksAhead).length;

    if (upcomingCount < 4) {
      // 1. Check 4-Month Unsold Relaunch Candidates (on hand > 0)
      const relaunchCandidates = batches.filter((b) => {
        if (b.section !== "active" || (parseInt(b.totalStock ?? 0, 10) || 0) <= 0) return false;
        const refMs = new Date(b.lastPromoAt || b.launchDate || 0).getTime();
        return refMs > 0 && now - refMs >= 120 * 24 * 3600 * 1000;
      });

      if (relaunchCandidates.length > 0) {
        const pick = relaunchCandidates[Math.floor(Math.random() * relaunchCandidates.length)];
        const relaunchDate = nextWeekdayAt19(now + 48 * 3600 * 1000, [1, 5]); // Monday or Friday 7PM
        const relaunchIso = relaunchDate.toISOString();
        pick.lastPromoAt = relaunchIso;
        batchesChanged = true;

        const copyText = `🔥 VAULT ENCORE! Only ${pick.totalStock} numbered units of our "${pick.theme}" ${pick.model} custom 1/64 remain in stock at neonllamagarage.com! Real Riders + custom collector card—once these last ${pick.totalStock} are gone, the mold closes forever. 🦙⚡`;
        schedule.push(
          {
            id: `EVT-${pick.id}-RELAUNCH-REV-${Date.now()}`,
            batchId: pick.id,
            theme: pick.theme,
            model: pick.model,
            phase: "REVEAL",
            scheduledAt: new Date(relaunchDate.getTime() - 24 * 3600 * 1000).toISOString(),
            status: "PENDING",
            mediaUrl: pick.heroImg || pick.hero || "",
            copy: { ig: copyText, fb: copyText, x: copyText.slice(0, 275), tt: copyText },
          },
          {
            id: `EVT-${pick.id}-RELAUNCH-LIVE-${Date.now() + 1}`,
            batchId: pick.id,
            theme: pick.theme,
            model: pick.model,
            phase: "OMNI_LAUNCH",
            scheduledAt: relaunchIso,
            status: "PENDING",
            mediaUrl: pick.heroImg || pick.hero || "",
            stripeLink: pick.stripeLink || "",
            copy: { ig: copyText, fb: copyText, x: copyText.slice(0, 275), tt: copyText },
          }
        );
        scheduleChanged = true;
      }

      // 2. Check 6-Month Sold-Out "Remember When" Vault Flashback Candidates (on hand == 0)
      const throwbackCandidates = batches.filter((b) => {
        if (b.section !== "vault" && (parseInt(b.totalStock ?? 0, 10) || 0) > 0) return false;
        const refMs = new Date(b.lastThrowbackAt || b.soldOutAt || b.launchDate || 0).getTime();
        return refMs > 0 && now - refMs >= 180 * 24 * 3600 * 1000;
      });

      if (throwbackCandidates.length > 0) {
        const pick = throwbackCandidates[Math.floor(Math.random() * throwbackCandidates.length)];
        const tbDate = nextWeekdayAt19(now + 24 * 3600 * 1000, [3, 0]); // Wed or Sun 7PM
        pick.lastThrowbackAt = tbDate.toISOString();
        batchesChanged = true;

        const tbCopy = `🏛️ FROM THE NEON LLAMA VAULT: Remember when our sold-out "${pick.theme}" ${pick.model} dropped? Every unit went home to collectors, never to be remade. Drop a 🦙 in the comments if you're holding one—and join the VIP list at neonllamagarage.com for the next build!`;
        schedule.push({
          id: `EVT-${pick.id}-FLASHBACK-${Date.now()}`,
          batchId: pick.id,
          theme: pick.theme,
          model: pick.model,
          phase: "FLASHBACK",
          scheduledAt: tbDate.toISOString(),
          status: "PENDING",
          mediaUrl: pick.heroImg || pick.hero || "",
          copy: { ig: tbCopy, fb: tbCopy, x: tbCopy.slice(0, 275), tt: tbCopy },
        });
        scheduleChanged = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // B. EXECUTE ALL DUE CHRONOS EVENTS
  // ---------------------------------------------------------------------------
  let processed = 0;
  for (const ev of schedule) {
    if (ev.status !== "PENDING") continue;
    const dueMs = new Date(ev.scheduledAt).getTime();
    if (isNaN(dueMs) || dueMs > now) continue;

    scheduleChanged = true;
    const batch = batches.find((b) => b.id === ev.batchId);
    const currentStock = batch ? parseInt(batch.totalStock ?? 0, 10) || 0 : 1;

    try {
      // Skip +72h eBay Marketplace reminder if batch ALREADY sold out!
      if (ev.phase === "MARKETPLACE_SYNC" && currentStock <= 0) {
        ev.status = "SKIPPED_SOLDOUT";
        ev.executedAt = new Date().toISOString();
        continue;
      }

      if (
        ["TEASER", "PROCESS", "REVEAL", "OMNI_LAUNCH", "FLASHBACK"].includes(ev.phase) &&
        env.MAKE_WEBHOOK_URL
      ) {
        const postTypeMap = { TEASER: 1, PROCESS: 2, REVEAL: 3, OMNI_LAUNCH: 4, FLASHBACK: 6 };
        const makeResp = await fetch(env.MAKE_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventId: ev.id,
            batchId: ev.batchId,
            theme: ev.theme,
            model: ev.model,
            phase: ev.phase,
            postType: postTypeMap[ev.phase] || 4,
            mediaType: String(ev.mediaUrl || "").endsWith(".mp4") ? "video" : "image",
            mediaUrl: ev.mediaUrl || "",
            stripeLink: ev.stripeLink || "",
            storeUrl: "https://neonllamagarage.com",
            copy: ev.copy || {},
          }),
        });
        if (!makeResp.ok) throw new Error(`Make.com HTTP ${makeResp.status}`);
      } else if (ev.phase === "T-1h_VIP") {
        // Relay VIP launch blast notice to Telegram + GAS email helper
        const crm = (await env.NLG_DB.get("crm_v1", "json")) || [];
        await sendTelegramAlert(
          env,
          `👑 *T-1h VIP EARLY ACCESS WINDOW*\n*${ev.batchId}: ${ev.theme} (${ev.model})*\n• VIP List: ${crm.length} Collectors\n• Checkout: ${ev.stripeLink || "https://neonllamagarage.com"}`
        );
      } else if (ev.phase === "MARKETPLACE_SYNC") {
        await sendTelegramAlert(
          env,
          `📦 *+72h UNSOLD STOCK CHECK*\n*${ev.batchId}: ${ev.theme} (${ev.model})* still has *${currentStock} unit(s)* remaining — ready for eBay cross-listing!`
        );
      } else if (ev.phase === "ARCHIVE_SWEEP") {
        await sendTelegramAlert(
          env,
          `🧹 *+18d ARCHIVE SWEEP*\n18-day eBay window reached for *${ev.batchId}: ${ev.theme} (${ev.model})*.`
        );
      }

      ev.status = "SUCCESS";
      ev.executedAt = new Date().toISOString();
      processed++;

      if (["TEASER", "PROCESS", "REVEAL", "OMNI_LAUNCH", "FLASHBACK"].includes(ev.phase)) {
        await sendTelegramAlert(
          env,
          `✅ *CHRONOS AUTO-POST FIRED*\n• Phase: *${ev.phase}*\n• Drop: *${ev.batchId} — ${ev.theme} (${ev.model})*`
        );
      }
    } catch (err) {
      ev.status = "FAILED";
      ev.error = err.message;
      await sendTelegramAlert(
        env,
        `🚨 *CHRONOS POST FAILED*\n• Phase: *${ev.phase}* (${ev.batchId})\n• Error: ${err.message}`
      );
    }
  }

  if (batchesChanged) await env.NLG_DB.put("batches_v1", JSON.stringify(batches));
  if (scheduleChanged) await env.NLG_DB.put("schedule_v1", JSON.stringify(schedule));
  return { processed };
}

function nextWeekdayAt19(fromMs, allowedDays) {
  const d = new Date(fromMs);
  d.setHours(19, 0, 0, 0);
  while (!allowedDays.includes(d.getDay())) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

async function sendTelegramAlert(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (_) {}
}
