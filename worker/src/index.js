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
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Secret",
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
      const ebay = await getEbayStatus(env);
      return jsonResp({
        status: "ok",
        service: "Neon Llama Single-Source Studio & Chronos Engine v2.5",
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        kvConfigured: Boolean(env.NLG_DB),
        r2Configured: Boolean(env.MEDIA_BUCKET),
        stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
        makeConfigured: Boolean(env.MAKE_WEBHOOK_URL),
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        ebayClientConfigured: ebay.clientConfigured,
        ebayOAuthReady: ebay.oauthReady,
        ebayConnectedUser: ebay.username || null,
        gasEmailRelay: true,
        vision2Sweep: true,
        timestamp: new Date().toISOString(),
      });
    }

    // -------------------------------------------------------------------------
    // 0B. EBAY OAUTH 2.0 SETUP, ACCOUNT GUARD & CLEANUP
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/ebay/auth-url" && request.method === "GET") {
      try {
        const ebay = await getEbayStatus(env);
        const expectedSecret = env.EBAY_ADMIN_KEY || env.EBAY_CLIENT_SECRET;
        const provided = request.headers.get("x-admin-secret") || url.searchParams.get("key") || "";
        // Allow 1-click setup before first OAuth connection; require secret to overwrite afterward
        if (ebay.oauthReady && (!expectedSecret || provided !== expectedSecret)) {
          return jsonResp({ success: false, error: "eBay OAuth already connected. Pass ?key=<secret> to re-authorize." }, 401);
        }
        const authUrl = buildEbayConsentUrl(env);
        if (url.searchParams.get("redirect") !== "0") {
          return Response.redirect(authUrl, 302);
        }
        return jsonResp({ success: true, authUrl });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/ebay/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) {
        return jsonResp({ success: false, error: "Missing authorization code from eBay" }, 400);
      }
      try {
        const ebay = await getEbayStatus(env);
        const expectedSecret = env.EBAY_ADMIN_KEY || env.EBAY_CLIENT_SECRET;
        const provided = url.searchParams.get("state_key") || "";
        if (ebay.oauthReady && (!expectedSecret || provided !== expectedSecret)) {
          return jsonResp({ success: false, error: "eBay OAuth is already locked & active." }, 403);
        }
        const authResult = await exchangeEbayAuthCode(env, code);
        if (authResult.blockedWrongAccount) {
          return new Response(
            `<html><body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;padding:40px;text-align:center;max-width:640px;margin:0 auto;">
              <h1 style="color:#f59e0b;">⚠️ Blocked Wrong eBay Account (${authResult.username})</h1>
              <p>Your browser automatically signed in with <strong>${authResult.username}</strong> instead of your Neon Llama Garage eBay account, so we blocked it before saving!</p>
              <p style="background:#1e293b;padding:16px;border-radius:8px;line-height:1.6;">
                Right-click and open <strong><code>https://neonllamagarage.com/api/ebay/auth-url</code></strong> in an <strong>Incognito / Private Window</strong> so eBay asks you to log into <strong>NeonLlamaGarage</strong>.
              </p>
            </body></html>`,
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        // Immediately fire Chronos catch-up in background so D-001, D-002 & B-010 list right away!
        ctx.waitUntil(
          (async () => {
            await sendTelegramAlert(
              env,
              `🟢 *EBAY OAUTH CONNECTED (${authResult.username || "NLG"})*\n18-month token saved in SSoT KV — launching +72h catch-up listings now!`
            );
            await processChronosQueue(env, { force: true });
          })()
        );
        return new Response(
          `<html><body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;padding:40px;text-align:center;">
            <h1 style="color:#22d3ee;">✅ Connected eBay Seller: ${authResult.username || "NeonLlamaGarage"}!</h1>
            <p>Your 18-month OAuth Refresh Token is saved in Cloudflare KV (<code>NLG_DB</code>), and Chronos is now pushing <strong>D-001</strong>, <strong>D-002</strong>, and <strong>B-010</strong> to eBay ($59.99 + Free Shipping from 76052).</p>
            <p style="color:#94a3b8;font-size:14px;">Watch Telegram for your 3 live eBay links in ~10 seconds!</p>
          </body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/ebay/reset-account" && request.method === "POST") {
      try {
        const expectedSecret = env.EBAY_ADMIN_KEY || env.EBAY_CLIENT_SECRET;
        const provided = request.headers.get("x-admin-secret") || "";
        if (!expectedSecret || provided !== expectedSecret) {
          return jsonResp({ success: false, error: "Unauthorized" }, 401);
        }
        const batches = (await env.NLG_DB.get("batches_v1", "json")) || [];
        const schedule = (await env.NLG_DB.get("schedule_v1", "json")) || [];
        const endedItems = [];

        for (const b of batches) {
          if (b.ebayItemId) {
            try {
              const res = await endEbayListing(env, b.ebayItemId, "NotAvailable");
              endedItems.push({ batchId: b.id, itemId: b.ebayItemId, ...res });
            } catch (err) {
              endedItems.push({ batchId: b.id, itemId: b.ebayItemId, error: err.message });
            }
            delete b.ebayItemId;
            delete b.ebayUrl;
            delete b.ebayStatus;
            delete b.ebayPrice;
            delete b.ebayListedAt;
            delete b.ebayWindowEndsAt;
            delete b.ebayLastAttemptAt;
            delete b.ebayLastError;
          }
        }

        const cleanedSchedule = schedule.filter((ev) => !(ev.phase === "ARCHIVE_SWEEP" && ev.status === "PENDING"));
        await env.NLG_DB.put("batches_v1", JSON.stringify(batches));
        await env.NLG_DB.put("schedule_v1", JSON.stringify(cleanedSchedule));
        await env.NLG_DB.delete("ebay_oauth_v1");
        await env.NLG_DB.delete("ebay_access_token_v1");

        return jsonResp({ success: true, endedItems, resetComplete: true });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/ebay/catchup-live" && request.method === "POST") {
      try {
        const expectedSecret = env.EBAY_ADMIN_KEY || env.EBAY_CLIENT_SECRET;
        const provided = request.headers.get("x-admin-secret") || "";
        if (!expectedSecret || provided !== expectedSecret) {
          return jsonResp({ success: false, error: "Unauthorized" }, 401);
        }
        if (!env.NLG_DB) return jsonResp({ success: false, error: "NLG_DB KV not bound" }, 503);

        const body = await request.json().catch(() => ({}));
        const dryRun = body.dryRun !== false; // default safe dryRun=true unless explicitly false
        const targetIds = Array.isArray(body.batchIds) ? body.batchIds : null;

        const batches = (await env.NLG_DB.get("batches_v1", "json")) || [];
        const schedule = (await env.NLG_DB.get("schedule_v1", "json")) || [];
        const now = Date.now();
        const results = [];
        let changed = false;

        for (const b of batches) {
          const stock = parseInt(b.totalStock ?? 0, 10) || 0;
          const isEligible =
            b.section === "active" &&
            stock > 0 &&
            b.ebayStatus !== "ACTIVE" &&
            (!targetIds || targetIds.includes(b.id));
          if (!isEligible) continue;

          try {
            const res = await createOrVerifyEbayListing(env, b, { dryRun });
            results.push({ batchId: b.id, theme: b.theme, model: b.model, stock, ...res });

            if (!dryRun && res.itemId) {
              const sweepIso = new Date(now + 18 * 24 * 3600 * 1000).toISOString();
              b.ebayItemId = res.itemId;
              b.ebayUrl = res.ebayUrl;
              b.ebayStatus = "ACTIVE";
              b.ebayPrice = res.price;
              b.ebayListedAt = new Date(now).toISOString();
              b.ebayWindowEndsAt = sweepIso;
              changed = true;

              // Queue +18d ARCHIVE_SWEEP if none pending for this batch
              const hasSweep = schedule.some(
                (ev) => ev.batchId === b.id && ev.phase === "ARCHIVE_SWEEP" && ev.status === "PENDING"
              );
              if (!hasSweep) {
                schedule.push({
                  id: `EVT-${b.id}-ARCHIVE-${now}`,
                  batchId: b.id,
                  theme: b.theme,
                  model: b.model,
                  phase: "ARCHIVE_SWEEP",
                  scheduledAt: sweepIso,
                  status: "PENDING",
                });
              }
            }
          } catch (itemErr) {
            results.push({ batchId: b.id, theme: b.theme, model: b.model, error: itemErr.message });
          }
        }

        if (changed) {
          schedule.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
          await env.NLG_DB.put("batches_v1", JSON.stringify(batches));
          await env.NLG_DB.put("schedule_v1", JSON.stringify(schedule));

          const listedLines = results
            .filter((r) => r.ebayUrl)
            .map((r) => `• *${r.batchId}* (${r.theme} ${r.model}): ${r.ebayUrl}`)
            .join("\n");
          if (listedLines) {
            ctx.waitUntil(
              sendTelegramAlert(
                env,
                `🏷️ *EBAY SCARCITY-DRIP LIVE (1 QTY @ $59.99 FREE SHIP)*\n${listedLines}\n• Auto-replenishes 1-by-1 until +18d window or Sold Out!`
              )
            );
          }
        }

        return jsonResp({ success: true, dryRun, count: results.length, results });
      } catch (err) {
        return jsonResp({ success: false, error: err.message }, 500);
      }
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
        if (env.STRIPE_SECRET_KEY) {
          ctx.waitUntil(syncAllActiveStripeCaps(env.STRIPE_SECRET_KEY, body.batches));
        }
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
      const report = await processChronosQueue(env, { force: true });
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
                ebayStatus: isSoldOut && b.ebayStatus === "ACTIVE" ? "ENDED_SOLDOUT" : b.ebayStatus,
              };
              return soldBatch;
            });

            await env.NLG_DB.put("batches_v1", JSON.stringify(updated));

            if (soldBatch) {
              // If final unit just sold on NLG.com while eBay had a scarcity-drip unit open, end eBay immediately!
              if (remaining <= 0 && soldBatch.ebayItemId) {
                ctx.waitUntil(endEbayListing(env, soldBatch.ebayItemId, "NotAvailable").catch(() => {}));
              }

              const buyerEmail = session.customer_details?.email || session.customer_email || "Collector";
              ctx.waitUntil(
                sendTelegramAlert(
                  env,
                  `💰 *SALE CONFIRMED!* (${soldBatch.id})\n*${soldBatch.theme} — ${soldBatch.model}*\n• Buyer: ${buyerEmail} (Qty: ${qtyBought})\n• Remaining Stock: *${remaining}*${remaining <= 0 ? "\n🏛️ *SOLD OUT — AUTO-MOVED TO THE VAULT & EBAY ENDED!*" : ""}`
                )
              );

              // Vision 2.0 Rule: Auto-fire SOLD OUT celebration post to Make.com when stock hits 0!
              if (remaining <= 0) {
                ctx.waitUntil(fireSoldOutSocialBlast(env, soldBatch));
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
    "process": { "ig": "T-48h workshop custom build / UV decal / Real Riders ASMR caption w/ hashtags", "fb": "FB behind-the-build process post", "x": "Punchy X build process post (<260 chars)", "tt": "TikTok custom Hot Wheels build ASMR caption", "ytTitle": "YT Shorts Custom Build Process Title (<70 chars)", "ytDesc": "YT Shorts build description" },
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
// HELPER: ENFORCE EXACT REMAINING-STOCK HARD CAP ON STRIPE PAYMENT LINKS
// =============================================================================
async function syncStripeCapForBatch(stripeKey, batch, prefetchedLinks = null) {
  if (!stripeKey || !batch?.stripeLink) return;
  try {
    const cleanTarget = batch.stripeLink.split("?")[0];
    let links = prefetchedLinks;
    if (!links) {
      const listResp = await fetch("https://api.stripe.com/v1/payment_links?active=true&limit=100", {
        headers: { Authorization: `Bearer ${stripeKey}` },
      });
      if (!listResp.ok) return;
      const listData = await listResp.json();
      links = listData.data || [];
    }

    const match = links.find(
      (pl) =>
        pl.metadata?.batchId === batch.id ||
        (pl.url && pl.url.split("?")[0] === cleanTarget)
    );
    if (!match?.id) return;

    const remaining = Math.max(0, parseInt(batch.totalStock ?? 0, 10) || 0);
    if (remaining <= 0 || batch.section === "vault" || batch.status === "Sold") {
      await fetch(`https://api.stripe.com/v1/payment_links/${match.id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "active=false",
      });
      return;
    }

    // Count already-completed checkout sessions on this Payment Link so total limit = completed + remaining!
    let completedCount = 0;
    const sessResp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions?payment_link=${encodeURIComponent(match.id)}&status=complete&limit=100`,
      { headers: { Authorization: `Bearer ${stripeKey}` } }
    );
    if (sessResp.ok) {
      const sessData = await sessResp.json();
      completedCount = Array.isArray(sessData.data) ? sessData.data.length : 0;
    }

    const newLimit = Math.max(1, completedCount + remaining);
    const params = new URLSearchParams({
      "restrictions[completed_sessions][limit]": String(newLimit),
      "metadata[batchId]": String(batch.id),
    });

    await fetch(`https://api.stripe.com/v1/payment_links/${match.id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (_) {}
}

async function syncAllActiveStripeCaps(stripeKey, batches) {
  if (!stripeKey || !Array.isArray(batches)) return;
  try {
    const listResp = await fetch("https://api.stripe.com/v1/payment_links?active=true&limit=100", {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!listResp.ok) return;
    const listData = await listResp.json();
    const links = listData.data || [];
    for (const b of batches) {
      if (b.stripeLink && (b.section === "active" || b.section === "vault")) {
        await syncStripeCapForBatch(stripeKey, b, links);
      }
    }
  } catch (_) {}
}

// =============================================================================
// HELPER: VISION 2.0 SOLD-OUT SOCIAL CELEBRATION BLAST (LEGACY + V2 MAKE KEYS)
// =============================================================================
async function fireSoldOutSocialBlast(env, soldBatch) {
  if (!env.MAKE_WEBHOOK_URL || !soldBatch) return;
  const soldOutText = `🏛️ OFFICIALLY SOLD OUT! Every single 1-of-${soldBatch.plannedTotal || 10} "${soldBatch.theme}" ${soldBatch.model} has been claimed and locked in The Vault forever. Huge thank you to our collectors—make sure you're on the VIP list at neonllamagarage.com so you don't miss Friday's drop! 🦙🔥 #neonllamagarage #soldout #hotwheelscustom`;
  const xText = soldOutText.slice(0, 275);
  const heroMedia = soldBatch.heroImg || soldBatch.hero || "";
  try {
    await fetch(env.MAKE_WEBHOOK_URL, {
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
        mediaUrl: heroMedia,
        carouselStack: Array.isArray(soldBatch.images) ? soldBatch.images.slice(0, 6) : [],
        flashbackUrl: "",
        storeUrl: "https://neonllamagarage.com",
        storeLink: "https://neonllamagarage.com",
        igCopy: soldOutText,
        fbCopy: soldOutText,
        xCopy: xText,
        ttCopy: soldOutText,
        ytTitle: `SOLD OUT: "${soldBatch.theme}" ${soldBatch.model} Custom 1/64 #Shorts`.slice(0, 70),
        ytDesc: soldOutText,
        pinTitle: `SOLD OUT — Neon Llama Garage "${soldBatch.theme}" ${soldBatch.model}`,
        pinDesc: soldOutText,
        copy: { ig: soldOutText, fb: soldOutText, x: xText, tt: soldOutText },
      }),
    });
  } catch (_) {}
}

// =============================================================================
// HELPER: 15-MIN EBAY ORDER POLL + "SCARCITY DRIP" 1-BY-1 REPLENISHMENT
// =============================================================================
async function syncActiveEbayOrders(env, batches, now) {
  const ebay = await getEbayStatus(env);
  if (!ebay.oauthReady) return { ebaySalesProcessed: 0, batchesChanged: false };

  const hasAnyEbayHistory = batches.some((b) => Boolean(b.ebayItemId));
  if (!hasAnyEbayHistory) return { ebaySalesProcessed: 0, batchesChanged: false };

  let sales = [];
  try {
    sales = await fetchRecentEbaySales(env, 48);
  } catch (err) {
    await sendTelegramAlert(env, `⚠️ *EBAY SYNC CHECK WARNING*\n${err.message}`);
    return { ebaySalesProcessed: 0, batchesChanged: false };
  }
  if (sales.length === 0) return { ebaySalesProcessed: 0, batchesChanged: false };

  const processedList = (await env.NLG_DB.get("ebay_processed_orders_v1", "json")) || [];
  const processedSet = new Set(processedList);
  let batchesChanged = false;
  let processedOrdersChanged = false;
  let ebaySalesProcessed = 0;

  for (const sale of sales) {
    if (processedSet.has(sale.orderLineItemId)) continue;

    const batch = batches.find(
      (b) =>
        (sale.sku && b.id === sale.sku) ||
        (sale.itemId && String(b.ebayItemId) === String(sale.itemId))
    );
    if (!batch) continue;

    processedSet.add(sale.orderLineItemId);
    processedOrdersChanged = true;
    ebaySalesProcessed++;
    batchesChanged = true;

    const prevStock = Math.max(0, parseInt(batch.totalStock ?? 1, 10) || 1);
    const remaining = Math.max(0, prevStock - sale.qtyPurchased);
    const isSoldOut = remaining <= 0;

    batch.totalStock = remaining;
    batch.ebaySoldTotal = (parseInt(batch.ebaySoldTotal ?? 0, 10) || 0) + sale.qtyPurchased;
    batch.qty = isSoldOut ? "0 Available (Vaulted)" : `${remaining} In Stock`;

    if (isSoldOut) {
      batch.section = "vault";
      batch.status = "Sold";
      batch.soldOutAt = new Date(now).toISOString();
      batch.ebayStatus = "ENDED_SOLDOUT";

      await syncStripeCapForBatch(env.STRIPE_SECRET_KEY, batch);
      await endEbayListing(env, batch.ebayItemId, "NotAvailable").catch(() => {});
      await fireSoldOutSocialBlast(env, batch);

      await sendTelegramAlert(
        env,
        `💰 *EBAY SALE — FINAL UNIT SOLD OUT!* (${batch.id})\n*${batch.theme} — ${batch.model}*\n• Buyer: ${sale.buyerUserId} (${sale.shipTo || "US"})\n• Paid: $${sale.amountPaid || batch.ebayPrice || "59.99"}\n• Remaining Stock: *0*\n🏛️ *Auto-vaulted on NLG.com & Stripe link deactivated!*`
      );
    } else {
      // Immediately lower Stripe's hard session cap to match the new lower physical count!
      await syncStripeCapForBatch(env.STRIPE_SECRET_KEY, batch);

      const windowOpen = !batch.ebayWindowEndsAt || now < new Date(batch.ebayWindowEndsAt).getTime();
      let dripNote = "• 18-day eBay window elapsed — keeping remaining stock on NLG.com only.";

      if (windowOpen) {
        try {
          await reviseEbayQuantity(env, batch.ebayItemId, 1);
          batch.ebayStatus = "ACTIVE";
          dripNote = `• 🔄 *Scarcity Drip:* Restocked 1 unit on eBay (${batch.ebayUrl})`;
        } catch (_) {
          // Single-qty listing auto-closed when purchased -> launch fresh 1-qty listing seamlessly!
          try {
            const relisted = await createOrVerifyEbayListing(env, batch, { dryRun: false });
            batch.ebayItemId = relisted.itemId;
            batch.ebayUrl = relisted.ebayUrl;
            batch.ebayStatus = "ACTIVE";
            dripNote = `• 🔄 *Scarcity Drip:* Relisted fresh 1-qty unit on eBay (${relisted.ebayUrl})`;
          } catch (relistErr) {
            batch.ebayStatus = "DRIP_ERROR";
            dripNote = `• ⚠️ *Drip Restock Failed:* ${relistErr.message}`;
          }
        }
      } else {
        batch.ebayStatus = "ENDED_WINDOW";
      }

      await sendTelegramAlert(
        env,
        `💰 *EBAY SALE CONFIRMED!* (${batch.id})\n*${batch.theme} — ${batch.model}*\n• Buyer: ${sale.buyerUserId} (${sale.shipTo || "US"})\n• Paid: $${sale.amountPaid || batch.ebayPrice || "59.99"} (Qty: ${sale.qtyPurchased})\n• Remaining Stock: *${remaining}* (Stripe cap synced)\n${dripNote}`
      );
    }
  }

  if (processedOrdersChanged) {
    const trimmed = Array.from(processedSet).slice(-500);
    await env.NLG_DB.put("ebay_processed_orders_v1", JSON.stringify(trimmed));
  }

  return { ebaySalesProcessed, batchesChanged };
}

// =============================================================================
// HELPER: PROCESS CHRONOS QUEUE + VISION 2.0 WEEKLY RELAUNCH & THROWBACK SWEEP
// =============================================================================
async function processChronosQueue(env, { force = false } = {}) {
  if (!env.NLG_DB) return { processed: 0 };
  const now = Date.now();

  // Throttle check so opportunistic HTTP pulses don't hammer KV more than once per 5 min
  if (!force) {
    const lastPulse = parseInt((await env.NLG_DB.get("chronos_last_pulse")) || "0", 10);
    if (now - lastPulse < 5 * 60 * 1000) return { processed: 0, skippedThrottle: true };
  }
  await env.NLG_DB.put("chronos_last_pulse", String(now));

  const batches = (await env.NLG_DB.get("batches_v1", "json")) || [];
  let schedule = (await env.NLG_DB.get("schedule_v1", "json")) || [];
  let batchesChanged = false;
  let scheduleChanged = false;

  // ---------------------------------------------------------------------------
  // 0A. WRONG-ACCOUNT SILO GUARD (AUTO-UNWINDS PIKES1313 IF EVER CONNECTED)
  // ---------------------------------------------------------------------------
  const storedOauth = await env.NLG_DB.get("ebay_oauth_v1", "json");
  if (storedOauth?.refresh_token && (!storedOauth.username || storedOauth.username.toLowerCase() === "pikes1313")) {
    try {
      const tok = await getValidEbayAccessToken(env);
      const actualUser = await fetchTokenEbayUsername(tok);
      if (actualUser && actualUser.toLowerCase() === "pikes1313") {
        const endedIds = [];
        for (const b of batches) {
          if (b.ebayItemId) {
            await endEbayListing(env, b.ebayItemId, "NotAvailable").catch(() => {});
            endedIds.push(`${b.id}:${b.ebayItemId}`);
            delete b.ebayItemId;
            delete b.ebayUrl;
            delete b.ebayStatus;
            delete b.ebayPrice;
            delete b.ebayListedAt;
            delete b.ebayWindowEndsAt;
            delete b.ebayLastAttemptAt;
            delete b.ebayLastError;
          }
        }
        const cleanedSched = schedule.filter((ev) => !(ev.phase === "ARCHIVE_SWEEP" && ev.status === "PENDING"));
        await env.NLG_DB.put("batches_v1", JSON.stringify(batches));
        await env.NLG_DB.put("schedule_v1", JSON.stringify(cleanedSched));
        await env.NLG_DB.delete("ebay_oauth_v1");
        await env.NLG_DB.delete("ebay_access_token_v1");
        await sendTelegramAlert(
          env,
          `🛡️ *EBAY SILO GUARD*\nEnded ${endedIds.length} listing(s) on \`pikes1313\` (${endedIds.join(", ")}) and disconnected \`pikes1313\` so you can sign in with *NeonLlamaGarage*!`
        );
        return { processed: 0, cleanedWrongEbayAccount: actualUser, endedIds };
      } else if (actualUser) {
        storedOauth.username = actualUser;
        await env.NLG_DB.put("ebay_oauth_v1", JSON.stringify(storedOauth));
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 0. SYNC ACTIVE EBAY SALES & SCARCITY-DRIP 1-BY-1 RESTOCK
  // ---------------------------------------------------------------------------
  const ebaySync = await syncActiveEbayOrders(env, batches, now);
  if (ebaySync.batchesChanged) batchesChanged = true;

  // ---------------------------------------------------------------------------
  // 0B. SELF-HEALING +72h EBAY AUTO-LIST (CATCHES D-001, D-002, B-010 + FUTURE)
  //     Any active in-stock batch >=72h past launchDate that hasn't had its
  //     initial eBay run (!ebayStatus && !ebayItemId) auto-lists automatically!
  // ---------------------------------------------------------------------------
  const ebayReadyCheck = await getEbayStatus(env);
  if (ebayReadyCheck.oauthReady) {
    for (const b of batches) {
      const stock = parseInt(b.totalStock ?? 0, 10) || 0;
      const launchMs = new Date(b.launchDate || 0).getTime();
      const lastTryMs = new Date(b.ebayLastAttemptAt || 0).getTime();
      const hasPendingMkt = schedule.some(
        (ev) => ev.batchId === b.id && ev.phase === "MARKETPLACE_SYNC" && ev.status === "PENDING"
      );

      if (
        b.section === "active" &&
        stock > 0 &&
        !b.ebayStatus &&
        !b.ebayItemId &&
        !hasPendingMkt &&
        launchMs > 0 &&
        now - launchMs >= 72 * 3600 * 1000 &&
        (force || now - lastTryMs >= 6 * 3600 * 1000)
      ) {
        b.ebayLastAttemptAt = new Date(now).toISOString();
        batchesChanged = true;
        try {
          const listed = await createOrVerifyEbayListing(env, b, { dryRun: false });
          const sweepIso = new Date(now + 18 * 24 * 3600 * 1000).toISOString();
          b.ebayItemId = listed.itemId;
          b.ebayUrl = listed.ebayUrl;
          b.ebayStatus = "ACTIVE";
          b.ebayPrice = listed.price;
          b.ebayListedAt = new Date(now).toISOString();
          b.ebayWindowEndsAt = sweepIso;
          delete b.ebayLastError;

          const hasSweep = schedule.some(
            (ev) => ev.batchId === b.id && ev.phase === "ARCHIVE_SWEEP" && ev.status === "PENDING"
          );
          if (!hasSweep) {
            schedule.push({
              id: `EVT-${b.id}-ARCHIVE-${now}`,
              batchId: b.id,
              theme: b.theme,
              model: b.model,
              phase: "ARCHIVE_SWEEP",
              scheduledAt: sweepIso,
              status: "PENDING",
            });
            scheduleChanged = true;
          }

          await sendTelegramAlert(
            env,
            `🏷️ *AUTO-LISTED ON EBAY (+72h SCARCITY DRIP)*\n*${b.id}: ${b.theme} (${b.model})*\n• Listed: *1 unit* @ *$${listed.price}* (Free Shipping from 76052)\n• Reserve Stock: *${stock} total*\n• Live URL: ${listed.ebayUrl}`
          );
        } catch (err) {
          b.ebayLastError = err.message;
          await sendTelegramAlert(
            env,
            `🚨 *EBAY AUTO-LIST ERROR* (${b.id}: ${b.theme})\n• ${err.message}`
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // A. VISION 2.0 WEEKLY SWEEP (4-Month Unsold Relaunch + 6-Month Vault Throwback)
  //    Rules from Vision2.0 sheet:
  //    • New launches ALWAYS take priority
  //    • Max 2 events/week, max 1 relaunch/week (Friday or Monday 7PM)
  //    • 4-month (120d) threshold if totalStock > 0 -> Mini-Relaunch (Reveal -24h, Go Live, +48h eBay, +18d End eBay)
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
        const relaunchMs = relaunchDate.getTime();
        const relaunchIso = relaunchDate.toISOString();
        pick.lastPromoAt = relaunchIso;
        batchesChanged = true;

        const copyText = `🔥 VAULT ENCORE! Only ${pick.totalStock} numbered units of our "${pick.theme}" ${pick.model} custom 1/64 remain in stock at neonllamagarage.com! Real Riders + custom collector card—once these last ${pick.totalStock} are gone, the mold closes forever. 🦙⚡`;
        schedule.push(
          {
            id: `EVT-${pick.id}-RELAUNCH-REV-${now}`,
            batchId: pick.id,
            theme: pick.theme,
            model: pick.model,
            phase: "REVEAL",
            scheduledAt: new Date(relaunchMs - 24 * 3600 * 1000).toISOString(),
            status: "PENDING",
            mediaUrl: pick.heroImg || pick.hero || "",
            copy: { ig: copyText, fb: copyText, x: copyText.slice(0, 275), tt: copyText },
          },
          {
            id: `EVT-${pick.id}-RELAUNCH-LIVE-${now + 1}`,
            batchId: pick.id,
            theme: pick.theme,
            model: pick.model,
            phase: "OMNI_LAUNCH",
            scheduledAt: relaunchIso,
            status: "PENDING",
            mediaUrl: pick.heroImg || pick.hero || "",
            stripeLink: pick.stripeLink || "",
            copy: { ig: copyText, fb: copyText, x: copyText.slice(0, 275), tt: copyText },
          },
          {
            id: `EVT-${pick.id}-RELAUNCH-MKT-${now + 2}`,
            batchId: pick.id,
            theme: pick.theme,
            model: pick.model,
            phase: "MARKETPLACE_SYNC",
            scheduledAt: new Date(relaunchMs + 48 * 3600 * 1000).toISOString(),
            status: "PENDING",
          },
          {
            id: `EVT-${pick.id}-RELAUNCH-ARCH-${now + 3}`,
            batchId: pick.id,
            theme: pick.theme,
            model: pick.model,
            phase: "ARCHIVE_SWEEP",
            scheduledAt: new Date(relaunchMs + 18 * 24 * 3600 * 1000).toISOString(),
            status: "PENDING",
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
          id: `EVT-${pick.id}-FLASHBACK-${now}`,
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
  const ebay = await getEbayStatus(env);
  let processed = 0;

  for (const ev of schedule) {
    if (ev.status !== "PENDING") continue;
    const dueMs = new Date(ev.scheduledAt).getTime();
    if (isNaN(dueMs) || dueMs > now) continue;

    scheduleChanged = true;
    const batch = batches.find((b) => b.id === ev.batchId);
    const currentStock = batch ? parseInt(batch.totalStock ?? 0, 10) || 0 : 0;

    try {
      // Skip +72h eBay auto-listing if batch ALREADY sold out!
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
        const cp = ev.copy || {};
        const targetStoreLink =
          ev.phase === "OMNI_LAUNCH" && ev.stripeLink
            ? ev.stripeLink
            : `https://neonllamagarage.com/#${ev.batchId}`;
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
            carouselStack: Array.isArray(batch?.images) ? batch.images.slice(0, 6) : [],
            flashbackUrl: ev.phase === "FLASHBACK" ? ev.mediaUrl || "" : "",
            stripeLink: ev.stripeLink || "",
            storeUrl: "https://neonllamagarage.com",
            storeLink: targetStoreLink,
            igCopy: cp.ig || "",
            fbCopy: cp.fb || "",
            xCopy: cp.x || "",
            ttCopy: cp.tt || "",
            ytTitle: cp.ytTitle || `${ev.theme} ${ev.model} Custom 1/64 #Shorts`.slice(0, 70),
            ytDesc: cp.ytDesc || cp.ig || "",
            pinTitle: cp.pinTitle || `Neon Llama Garage "${ev.theme}" ${ev.model} 1/64 Custom`,
            pinDesc: cp.pinDesc || cp.fb || cp.ig || "",
            copy: cp,
          }),
        });
        if (!makeResp.ok) throw new Error(`Make.com HTTP ${makeResp.status}`);
      } else if (ev.phase === "T-1h_VIP") {
        const crm = (await env.NLG_DB.get("crm_v1", "json")) || [];
        const emails = crm.map((x) => x.email).filter(Boolean);
        if (emails.length > 0) {
          await fetch(LEGACY_GAS_EMAIL_RELAY, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
              type: "vip_blast",
              template: "VIP_Early_Access",
              batchId: ev.batchId,
              title: ev.title || `${ev.theme} ${ev.model}`,
              link: ev.stripeLink || `https://neonllamagarage.com/#${ev.batchId}`,
              heroImg: ev.heroImg || batch?.hero || "",
              recipients: emails,
            }),
          }).catch(() => {});
        }
        await sendTelegramAlert(
          env,
          `👑 *T-1h VIP EARLY ACCESS WINDOW*\n*${ev.batchId}: ${ev.theme} (${ev.model})*\n• VIP List Emailed: ${emails.length} Collectors\n• Checkout: ${ev.stripeLink || "https://neonllamagarage.com"}`
        );
      } else if (ev.phase === "MARKETPLACE_SYNC") {
        if (!batch) throw new Error(`Batch ${ev.batchId} not found in batches_v1`);
        if (ebay.oauthReady) {
          if (batch.ebayStatus !== "ACTIVE" || !batch.ebayItemId) {
            const listed = await createOrVerifyEbayListing(env, batch, { dryRun: false });
            batch.ebayItemId = listed.itemId;
            batch.ebayUrl = listed.ebayUrl;
            batch.ebayStatus = "ACTIVE";
            batch.ebayPrice = listed.price;
            batch.ebayListedAt = new Date(now).toISOString();
            batch.ebayWindowEndsAt = new Date(now + 18 * 24 * 3600 * 1000).toISOString();
            batchesChanged = true;

            await sendTelegramAlert(
              env,
              `🏷️ *AUTO-LISTED ON EBAY (+72h SCARCITY DRIP)*\n*${batch.id}: ${batch.theme} (${batch.model})*\n• Listed: *1 unit* @ *$${listed.price}* (Free Shipping)\n• Reserve Stock: *${currentStock} total*\n• Live URL: ${listed.ebayUrl}`
            );
          }
        } else {
          throw new Error("eBay OAuth credentials not configured yet on Worker");
        }
      } else if (ev.phase === "ARCHIVE_SWEEP") {
        if (batch?.ebayItemId && ebay.oauthReady) {
          await endEbayListing(env, batch.ebayItemId, "NotAvailable");
          batch.ebayStatus = "ENDED_WINDOW";
          batchesChanged = true;
          await sendTelegramAlert(
            env,
            `🧹 *+18d EBAY WINDOW ENDED*\nEnded eBay listing \`${batch.ebayItemId}\` for *${batch.id}: ${batch.theme} (${batch.model})*.\n• *${currentStock} unit(s)* remain exclusively on NeonLlamaGarage.com!`
          );
        } else {
          await sendTelegramAlert(
            env,
            `🧹 *+18d ARCHIVE SWEEP*\n18-day window reached for *${ev.batchId}: ${ev.theme} (${ev.model})*.`
          );
        }
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
        `🚨 *CHRONOS EVENT FAILED*\n• Phase: *${ev.phase}* (${ev.batchId})\n• Error: ${err.message}`
      );
    }
  }

  if (batchesChanged) await env.NLG_DB.put("batches_v1", JSON.stringify(batches));
  if (scheduleChanged) await env.NLG_DB.put("schedule_v1", JSON.stringify(schedule));
  return { processed, ebaySalesProcessed: ebaySync.ebaySalesProcessed };
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

// =============================================================================
// NEON LLAMA GARAGE — EBAY AUTONOMOUS SCARCITY-DRIP ENGINE (TRADING + OAUTH API)
// =============================================================================
// Strategy:
//  • Pricing: $59.99 + Free USPS Ground Advantage Shipping (offsets ~13.25% fees)
//  • Scarcity Drip: Always list Quantity = 1 ("Last One / Only 1 Available")
//  • Replenishment: 15-min Chronos sync checks GetOrders; when 1 sells on eBay,
//    decrements NLG KV stock, updates/deactivates Stripe if 0, and drips 1 more
//    unit back onto eBay (while totalStock > 0 and inside 18-day window).
//  • Safety: Strips off-eBay URLs & lottery/raffle trigger words for 100% eBay
//    policy compliance, and enforces <= 80 char collector SEO titles.
// =============================================================================

const EBAY_OAUTH_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_OAUTH_AUTHORIZE_URL = "https://auth.ebay.com/oauth2/authorize";
const EBAY_TRADING_API_URL = "https://api.ebay.com/ws/api.dll";
const EBAY_COMPATIBILITY_LEVEL = "1225";
const EBAY_DIECAST_CATEGORY_ID = "180506"; // Toys & Hobbies > Diecast > Cars, Trucks & Vans > Contemporary
const DEFAULT_EBAY_PRICE_USD = 59.99;
const DEFAULT_EBAY_CLIENT_ID = "DerekPik-NeonLlam-PRD-30966c2d8-ee8ca90b";
const DEFAULT_EBAY_RUNAME = "Derek_Pike-DerekPik-NeonLl-mgnqyeah";

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
].join(" ");

// -----------------------------------------------------------------------------
// 1. OAUTH 2.0 CONFIG & ACCESS TOKEN MANAGEMENT
// -----------------------------------------------------------------------------
export async function getEbayStatus(env) {
  const clientId = env.EBAY_CLIENT_ID || DEFAULT_EBAY_CLIENT_ID;
  const clientConfigured = Boolean(clientId && env.EBAY_CLIENT_SECRET);
  let hasRefreshToken = Boolean(env.EBAY_REFRESH_TOKEN);
  let username = null;
  if (env.NLG_DB) {
    const stored = await env.NLG_DB.get("ebay_oauth_v1", "json");
    if (stored?.refresh_token) hasRefreshToken = true;
    if (stored?.username) username = stored.username;
  }
  return {
    clientConfigured,
    oauthReady: clientConfigured && hasRefreshToken,
    username,
    postalCodeConfigured: true,
  };
}

export function buildEbayConsentUrl(env, state = "nlg_ebay_setup") {
  const clientId = env.EBAY_CLIENT_ID || DEFAULT_EBAY_CLIENT_ID;
  const ruName = env.EBAY_RUNAME || DEFAULT_EBAY_RUNAME;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: ruName,
    scope: EBAY_SCOPES,
    state,
    prompt: "login",
  });
  return `${EBAY_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function fetchTokenEbayUsername(accessToken) {
  try {
    const resp = await fetch(EBAY_TRADING_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": EBAY_COMPATIBILITY_LEVEL,
        "X-EBAY-API-CALL-NAME": "GetUser",
        "X-EBAY-API-IAF-TOKEN": accessToken,
      },
      body: `<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetUserRequest>`,
    });
    const xml = await resp.text();
    return extractXmlTag(xml, "UserID") || "";
  } catch (_) {
    return "";
  }
}

export async function exchangeEbayAuthCode(env, code) {
  const clientId = env.EBAY_CLIENT_ID || DEFAULT_EBAY_CLIENT_ID;
  const ruName = env.EBAY_RUNAME || DEFAULT_EBAY_RUNAME;
  if (!env.EBAY_CLIENT_SECRET) {
    throw new Error("Missing EBAY_CLIENT_SECRET on Worker.");
  }
  const basic = btoa(`${clientId}:${env.EBAY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ruName,
  });

  const resp = await fetch(EBAY_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`eBay OAuth exchange failed (${resp.status}): ${JSON.stringify(data)}`);
  }

  const username = await fetchTokenEbayUsername(data.access_token);
  if (username && username.toLowerCase() === "pikes1313") {
    return { blockedWrongAccount: true, username };
  }

  const now = Date.now();
  if (env.NLG_DB) {
    await env.NLG_DB.put(
      "ebay_oauth_v1",
      JSON.stringify({
        username: username || "NeonLlamaGarage",
        refresh_token: data.refresh_token,
        refresh_expires_at: now + (data.refresh_token_expires_in || 47304000) * 1000,
        updated_at: new Date(now).toISOString(),
      })
    );
    await env.NLG_DB.put(
      "ebay_access_token_v1",
      JSON.stringify({
        access_token: data.access_token,
        expires_at: now + Math.max(60, (data.expires_in || 7200) - 300) * 1000,
      })
    );
  }
  return { ...data, username };
}

export async function getValidEbayAccessToken(env) {
  const clientId = env.EBAY_CLIENT_ID || DEFAULT_EBAY_CLIENT_ID;
  if (!env.EBAY_CLIENT_SECRET) {
    throw new Error("EBAY_CLIENT_SECRET secret not configured.");
  }

  const now = Date.now();
  if (env.NLG_DB) {
    const cached = await env.NLG_DB.get("ebay_access_token_v1", "json");
    if (cached?.access_token && cached.expires_at > now) {
      return cached.access_token;
    }
  }

  let refreshToken = env.EBAY_REFRESH_TOKEN || "";
  if (env.NLG_DB) {
    const stored = await env.NLG_DB.get("ebay_oauth_v1", "json");
    if (stored?.refresh_token) refreshToken = stored.refresh_token;
  }
  if (!refreshToken) {
    throw new Error("No eBay refresh token found. Complete /api/ebay/auth-url or set EBAY_REFRESH_TOKEN.");
  }

  const basic = btoa(`${clientId}:${env.EBAY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const resp = await fetch(EBAY_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`eBay token refresh failed (${resp.status}): ${JSON.stringify(data)}`);
  }

  if (env.NLG_DB) {
    await env.NLG_DB.put(
      "ebay_access_token_v1",
      JSON.stringify({
        access_token: data.access_token,
        expires_at: now + Math.max(60, (data.expires_in || 7200) - 300) * 1000,
      })
    );
  }
  return data.access_token;
}

// -----------------------------------------------------------------------------
// 2. XML TRADING API TRANSPORT + SAFE PARSERS
// -----------------------------------------------------------------------------
function xmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = String(xml).match(re);
  return m ? m[1].trim() : "";
}

function extractAllXmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const matches = [];
  let m;
  while ((m = re.exec(String(xml))) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

async function callEbayTradingApi(env, callName, innerXml) {
  const token = await getValidEbayAccessToken(env);
  const fullXml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${callName}Request>`;

  const resp = await fetch(EBAY_TRADING_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": EBAY_COMPATIBILITY_LEVEL,
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: fullXml,
  });

  const respXml = await resp.text();
  const ack = extractXmlTag(respXml, "Ack");
  const errorBlocks = extractAllXmlBlocks(respXml, "Errors");
  const hardErrors = [];
  const warnings = [];

  for (const eb of errorBlocks) {
    const sev = extractXmlTag(eb, "SeverityCode");
    const code = extractXmlTag(eb, "ErrorCode");
    const longMsg = extractXmlTag(eb, "LongMessage") || extractXmlTag(eb, "ShortMessage");
    if (sev === "Error") hardErrors.push(`[${code}] ${longMsg}`);
    else warnings.push(`[${code}] ${longMsg}`);
  }

  if (!resp.ok || (ack !== "Success" && ack !== "Warning")) {
    throw new Error(
      `eBay ${callName} failed (HTTP ${resp.status}, Ack=${ack || "None"}): ${
        hardErrors.join(" | ") || respXml.slice(0, 400)
      }`
    );
  }

  return { ack, xml: respXml, warnings };
}

// -----------------------------------------------------------------------------
// 3. COLLECTOR TITLE (<= 80 CHARS) & POLICY-SAFE HTML BUILDERS
// -----------------------------------------------------------------------------
export function buildEbayTitle(batch) {
  const theme = String(batch.theme || "Custom").trim();
  const model = String(batch.model || "Diecast").trim();
  const planned = parseInt(batch.plannedTotal ?? 10, 10) || 10;

  // Prefer structured collector SEO keywords: Custom Hot Wheels + Model + Theme + Real Riders + Limited
  const candidates = [
    `Custom Hot Wheels ${model} "${theme}" 1/64 Real Riders Limited 1/${planned} Neon Llama`,
    `Custom Hot Wheels ${model} "${theme}" 1/64 Real Riders Diecast Neon Llama`,
    `Custom Hot Wheels ${model} "${theme}" 1/64 Real Riders Diecast`,
    `Custom Hot Wheels ${model} ${theme} 1/64 Real Riders`,
    `${model} "${theme}" Custom 1/64 Diecast Real Riders`,
  ];

  for (const c of candidates) {
    const clean = c.replace(/\s+/g, " ").trim();
    if (clean.length <= 80) return clean;
  }
  return candidates[candidates.length - 1].slice(0, 80).trim();
}

function inferVehicleMake(model = "") {
  const m = model.toLowerCase();
  if (/silverado|camaro|chevy|gasser|corvette|impala|nova|bel air/.test(m)) return "Chevrolet";
  if (/porsche|911|935/.test(m)) return "Porsche";
  if (/nissan|skyline|silvia|gt-r|datsun/.test(m)) return "Nissan";
  if (/vw|volkswagen|bug|beetle|kombi|bus/.test(m)) return "Volkswagen";
  if (/ford|mustang|bronco|f-150/.test(m)) return "Ford";
  if (/dodge|charger|challenger/.test(m)) return "Dodge";
  return "Hot Wheels";
}

function inferPrimaryColor(color = "") {
  const c = color.toLowerCase();
  if (c.includes("purple") || c.includes("violet") || c.includes("amethyst")) return "Purple";
  if (c.includes("silver") || c.includes("chrome")) return "Silver";
  if (c.includes("blue")) return "Blue";
  if (c.includes("pink")) return "Pink";
  if (c.includes("white")) return "White";
  if (c.includes("green")) return "Green";
  if (c.includes("red")) return "Red";
  if (c.includes("black")) return "Black";
  return color || "Multi-Color";
}

export function selectOrderedEbayGallery(batch) {
  const raw = [];
  const pushUrl = (u) => {
    if (
      typeof u === "string" &&
      u.startsWith("https://") &&
      !u.includes("drive.google.com") &&
      !u.endsWith(".mp4") &&
      !raw.includes(u)
    ) {
      raw.push(u);
    }
  };

  // Prioritize crisp front blister / white-bg hero shots first, and EXCLUDE Chase-only
  // photos so an eBay buyer never mistakes the rare variant photo for a guaranteed Chase!
  const allImgs = [batch.hero, batch.heroPhoto, ...(Array.isArray(batch.images) ? batch.images : [])].filter(Boolean);
  const nonChase = allImgs.filter((u) => !/CHASE/i.test(u));
  const preferredOrder = [
    ...nonChase.filter((u) => /IMG_PKG_WHT|IMG_LOOSE_SINGLE/i.test(u)),
    ...nonChase.filter((u) => /IMG_PKG_F/i.test(u)),
    ...nonChase.filter((u) => /IMG_LOOSE|IMG_TOP|IMG_DCL_CU|IMG_PKG_CU|IMG_PKG_R/i.test(u)),
    ...nonChase,
  ];
  preferredOrder.forEach(pushUrl);
  if (raw.length === 0) allImgs.forEach(pushUrl);
  return raw.slice(0, 12);
}

export function buildPolicySafeEbayHtml(batch) {
  const theme = xmlEscape(batch.theme || "Custom Edition");
  const model = xmlEscape(batch.model || "1/64 Diecast");
  const color = xmlEscape(batch.color || "Custom Finish");
  const planned = parseInt(batch.plannedTotal ?? 10, 10) || 10;

  // Strip external URLs, Pike's 13 legacy name, and eBay-flagged "chance/raffle" sentences
  let cleanStory = String(batch.desc || "")
    .replace(/Pike's\s*13\s*Garage/gi, "Neon Llama Garage")
    .replace(/https?:\/\/[^\s<"']+/gi, "")
    .replace(/neonllamagarage\.com/gi, "Neon Llama Garage")
    .replace(/[^.!?\n]*\b(chance|pulling|raffle|lottery|odds)\b[^.!?\n]*[.!?]?/gi, "")
    .trim();

  if (!cleanStory) {
    cleanStory = `<p>Handcrafted in our father-son custom studio, the <strong>Neon Llama Garage "${theme}" ${model}</strong> is a collector-grade 1:64 custom diecast build featuring bespoke artwork, genuine rubber Real Rider wheels, and custom collector blister packaging.</p>`;
  }

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:0 auto;color:#1e293b;line-height:1.6;">
  <div style="background:#0f172a;color:#f8fafc;padding:20px 24px;border-radius:10px 10px 0 0;border-bottom:4px solid #06b6d4;">
    <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#22d3ee;font-weight:bold;">NEON LLAMA GARAGE • CUSTOM 1:64 COLLECTOR EDITION</div>
    <h1 style="margin:6px 0 0;font-size:22px;color:#ffffff;">"${theme}" — Custom ${model}</h1>
  </div>
  <div style="border:1px solid #cbd5e1;border-top:none;padding:24px;border-radius:0 0 10px 10px;background:#ffffff;">
    ${cleanStory}
    <h3 style="margin-top:20px;margin-bottom:10px;color:#0f172a;font-size:16px;border-bottom:1px solid #e2e8f0;padding-bottom:6px;">Build Specifications</h3>
    <ul style="margin:0;padding-left:20px;color:#334155;">
      <li><strong>Studio:</strong> Neon Llama Garage (Handcrafted Father-Son Custom Studio)</li>
      <li><strong>Base Casting:</strong> ${model} (1:64 Scale Diecast)</li>
      <li><strong>Edition / Livery:</strong> "${theme}" (${color})</li>
      <li><strong>Wheels:</strong> Authentic Rubber Real Rider Wheel Swap</li>
      <li><strong>Packaging:</strong> Resealed in Custom Collector Art Blister Card</li>
      <li><strong>Production Run:</strong> Micro-Batch Limited Run (${planned} Total Units Built)</li>
      <li><strong>Shipping:</strong> Fast &amp; Free USPS Ground Advantage in a Sturdy Box</li>
    </ul>
    <p style="margin-top:18px;font-size:13px;color:#64748b;background:#f8fafc;padding:12px;border-radius:6px;">
      <strong>Collector Note:</strong> Each Neon Llama Garage piece is individually hand-customized from an authentic 1:64 diecast casting and sealed on a custom collector card. Packed carefully in a crush-resistant shipping box.
    </p>
  </div>
</div>`;
}

// -----------------------------------------------------------------------------
// 4. CREATE OR VERIFY FIXED-PRICE LISTING (QUANTITY = 1 SCARCITY DRIP @ $59.99)
// -----------------------------------------------------------------------------
export async function createOrVerifyEbayListing(env, batch, { dryRun = false } = {}) {
  const callName = dryRun ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem";
  const title = buildEbayTitle(batch);
  const htmlDesc = buildPolicySafeEbayHtml(batch);
  const gallery = selectOrderedEbayGallery(batch);
  if (gallery.length === 0) {
    throw new Error(`Batch ${batch.id} has no public HTTPS R2 photos for eBay.`);
  }

  const price = Number(batch.ebayPrice || env.EBAY_PRICE_USD || DEFAULT_EBAY_PRICE_USD).toFixed(2);
  const postalCode = String(env.EBAY_POSTAL_CODE || "76052").trim();
  const locationText = String(env.EBAY_LOCATION || "Haslet, TX").trim();
  const dispatchDays = parseInt(env.EBAY_DISPATCH_DAYS || "2", 10) || 2;
  const make = inferVehicleMake(batch.model);
  const color = inferPrimaryColor(batch.color);
  const isTruck = /silverado|truck|hauler|delivery|van/i.test(batch.model || "");

  const pictureUrlsXml = gallery.map((u) => `<PictureURL>${xmlEscape(u)}</PictureURL>`).join("\n      ");

  const innerXml = `
  <Item>
    <Title>${xmlEscape(title)}</Title>
    <SKU>${xmlEscape(batch.id)}</SKU>
    <Description><![CDATA[${htmlDesc}]]></Description>
    <PrimaryCategory>
      <CategoryID>${EBAY_DIECAST_CATEGORY_ID}</CategoryID>
    </PrimaryCategory>
    <StartPrice currencyID="USD">${price}</StartPrice>
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <ConditionID>1000</ConditionID>
    <Country>US</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>${dispatchDays}</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${xmlEscape(locationText)}</Location>
    <PostalCode>${xmlEscape(postalCode)}</PostalCode>
    <Quantity>1</Quantity>
    <PictureDetails>
      ${pictureUrlsXml}
    </PictureDetails>
    <ItemSpecifics>
      <NameValueList><Name>Brand</Name><Value>Hot Wheels</Value></NameValueList>
      <NameValueList><Name>Scale</Name><Value>1:64</Value></NameValueList>
      <NameValueList><Name>Material</Name><Value>Diecast</Value></NameValueList>
      <NameValueList><Name>Vehicle Make</Name><Value>${xmlEscape(make)}</Value></NameValueList>
      <NameValueList><Name>Vehicle Type</Name><Value>${isTruck ? "Pickup Truck" : "Car"}</Value></NameValueList>
      <NameValueList><Name>Model</Name><Value>${xmlEscape(batch.model || "Custom")}</Value></NameValueList>
      <NameValueList><Name>Color</Name><Value>${xmlEscape(color)}</Value></NameValueList>
      <NameValueList><Name>Theme</Name><Value>${xmlEscape(batch.theme || "Custom")}</Value></NameValueList>
      <NameValueList><Name>Series</Name><Value>Neon Llama Garage Custom</Value></NameValueList>
      <NameValueList><Name>Customized</Name><Value>Yes</Value></NameValueList>
      <NameValueList>
        <Name>Features</Name>
        <Value>Custom Built/Converted</Value>
        <Value>Limited Edition</Value>
        <Value>Unopened Box</Value>
      </NameValueList>
    </ItemSpecifics>
    <ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>USPSParcel</ShippingService>
        <FreeShipping>true</FreeShipping>
        <ShippingServiceCost currencyID="USD">0.00</ShippingServiceCost>
        <ShippingServiceAdditionalCost currencyID="USD">0.00</ShippingServiceAdditionalCost>
      </ShippingServiceOptions>
    </ShippingDetails>
    <ShipToLocations>US</ShipToLocations>
    <ShippingPackageDetails>
      <ShippingPackage>PackageThickEnvelope</ShippingPackage>
      <WeightMajor unit="lbs">0</WeightMajor>
      <WeightMinor unit="oz">6</WeightMinor>
    </ShippingPackageDetails>
    <ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption>
    </ReturnPolicy>
  </Item>`;

  const res = await callEbayTradingApi(env, callName, innerXml);
  const itemId = extractXmlTag(res.xml, "ItemID");
  return {
    dryRun,
    itemId,
    ebayUrl: itemId && itemId !== "0" ? `https://www.ebay.com/itm/${itemId}` : null,
    title,
    price: Number(price),
    galleryCount: gallery.length,
    warnings: res.warnings,
  };
}

// -----------------------------------------------------------------------------
// 5. REPLENISH SCARCITY DRIP QUANTITY OR END LISTING
// -----------------------------------------------------------------------------
export async function reviseEbayQuantity(env, itemId, quantity = 1) {
  const innerXml = `
  <InventoryStatus>
    <ItemID>${xmlEscape(itemId)}</ItemID>
    <Quantity>${Math.max(0, parseInt(quantity, 10) || 0)}</Quantity>
  </InventoryStatus>`;
  return callEbayTradingApi(env, "ReviseInventoryStatus", innerXml);
}

export async function endEbayListing(env, itemId, reason = "NotAvailable") {
  if (!itemId) return { skipped: true };
  try {
    const innerXml = `
  <ItemID>${xmlEscape(itemId)}</ItemID>
  <EndingReason>${xmlEscape(reason)}</EndingReason>`;
    const res = await callEbayTradingApi(env, "EndFixedPriceItem", innerXml);
    return { ended: true, itemId, warnings: res.warnings };
  } catch (err) {
    // Error 1047 = Auction/listing has already been closed (e.g. sold its single unit)
    if (String(err.message).includes("[1047]") || /already.*closed|ended/i.test(err.message)) {
      return { ended: true, alreadyEnded: true, itemId };
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// 6. POLL RECENT COMPLETED EBAY ORDERS (15-MIN CHRONOS SYNC)
// -----------------------------------------------------------------------------
export async function fetchRecentEbaySales(env, lookbackHours = 48) {
  const now = Date.now();
  const fromIso = new Date(now - lookbackHours * 3600 * 1000).toISOString();
  const toIso = new Date(now).toISOString();

  const innerXml = `
  <CreateTimeFrom>${fromIso}</CreateTimeFrom>
  <CreateTimeTo>${toIso}</CreateTimeTo>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>Completed</OrderStatus>
  <Pagination>
    <EntriesPerPage>50</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>`;

  const res = await callEbayTradingApi(env, "GetOrders", innerXml);
  const orderBlocks = extractAllXmlBlocks(res.xml, "Order");
  const lineSales = [];

  for (const ob of orderBlocks) {
    const orderId = extractXmlTag(ob, "OrderID");
    const buyerUserId = extractXmlTag(ob, "BuyerUserID");
    const shipBlock = extractXmlTag(ob, "ShippingAddress");
    const shipName = extractXmlTag(shipBlock, "Name");
    const shipCity = extractXmlTag(shipBlock, "CityName");
    const shipState = extractXmlTag(shipBlock, "StateOrProvince");
    const amountPaid = extractXmlTag(ob, "AmountPaid");

    const txBlocks = extractAllXmlBlocks(ob, "Transaction");
    for (const tx of txBlocks) {
      const orderLineItemId = extractXmlTag(tx, "OrderLineItemID") || `${orderId}-${extractXmlTag(tx, "TransactionID")}`;
      const qtyPurchased = parseInt(extractXmlTag(tx, "QuantityPurchased") || "1", 10) || 1;
      const itemBlock = extractXmlTag(tx, "Item");
      const itemId = extractXmlTag(itemBlock, "ItemID");
      const sku = extractXmlTag(itemBlock, "SKU") || extractXmlTag(tx, "SKU");
      const title = extractXmlTag(itemBlock, "Title");

      if (orderLineItemId && (sku || itemId)) {
        lineSales.push({
          orderId,
          orderLineItemId,
          itemId,
          sku,
          title,
          qtyPurchased,
          amountPaid,
          buyerUserId,
          shipTo: [shipName, shipCity, shipState].filter(Boolean).join(", "),
        });
      }
    }
  }
  return lineSales;
}
