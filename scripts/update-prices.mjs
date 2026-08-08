// update-prices.mjs
// Fetches current prices for each part in parts.json using SerpApi's
// Google Shopping engine (covers Amazon, Newegg, Best Buy, and more in one call),
// then writes the results to prices.json.

import { readFile, writeFile } from "fs/promises";

const SERPAPI_KEY = process.env.SERPAPI_KEY;

if (!SERPAPI_KEY) {
  console.error("Missing SERPAPI_KEY environment variable. Set it as a GitHub Actions secret.");
  process.exit(1);
}

async function fetchOffersForPart(part) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", part.query);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("num", "20");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SerpApi request failed for "${part.query}": ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const results = data.shopping_results || [];

  // Some searches (notably GPUs with a specific VRAM size) return
  // similarly-named but wrong variants, e.g. an 8GB card showing up for a
  // "16GB" search. Reject anything whose title conflicts with the part's
  // expected spec before we ever consider it as an offer.
  const passesVariantCheck = (title) => {
    const t = (title || "").toLowerCase();

    // Reject wrong model generation entirely (e.g. "5060 Ti" or "4070"
    // slipping into a "4060 Ti" search). Checked independent of VRAM.
    if (part.requireToken && !t.includes(part.requireToken.toLowerCase())) return false;

    if (!part.mustContain && !part.mustNotContain) return true;
    // Extract VRAM-looking tokens (handles "16gb", "16 gb", "16g", and model-number
    // suffixes like "o8g" — no leading \b since letter+digit combos lack a boundary there).
    const matches = [...t.matchAll(/(\d{1,2})\s*-?\s*g(b)?\b/g)];
    const sizes = matches.map(m => parseInt(m[1], 10)).filter(n => [8,10,12,16,24].includes(n));
    if (part.mustContain) {
      const wantsSize = part.mustContain.some(s => /^\d+\s*gb?$/i.test(s.replace(/\s/g,'')));
      if (wantsSize) {
        // Require explicit confirmation of the wanted size — don't assume on ambiguous titles.
        const wanted = parseInt(part.mustContain[0], 10);
        return sizes.includes(wanted);
      }
    }
    if (part.mustNotContain && part.mustNotContain.some(s => t.includes(s.toLowerCase()))) return false;
    return true;
  };

  // Keep only results that have both a price and a source/link, then
  // pick the best (lowest) offer per retailer so we get a clean
  // "one price per site" comparison instead of 20 near-duplicates.
  const bySite = new Map();
  for (const r of results) {
    if (!r.price || !r.source) continue;
    if (!passesVariantCheck(r.title)) continue;
    const priceNum = parsePrice(r.price);
    if (priceNum === null) continue;

    const existing = bySite.get(r.source);
    if (!existing || priceNum < existing.price) {
      bySite.set(r.source, {
        site: r.source,
        price: priceNum,
        priceDisplay: r.price,
        title: r.title,
        link: r.product_link || r.link || null,
        productId: r.product_id || null,
        immersiveToken: r.immersive_product_page_token || null,
      });
    }
  }

  let offers = Array.from(bySite.values()).sort((a, b) => a.price - b.price).slice(0, 6);

  // The Google Shopping result's "link" is often just a Google search/results
  // page rather than the retailer's real product page. For the single
  // cheapest offer, do one extra lookup to resolve an actual merchant link
  // so at least the top recommendation is directly clickable.
  if (offers.length > 0 && offers[0].immersiveToken) {
    try {
      const realLink = await resolveMerchantLink(offers[0].immersiveToken, offers[0].site);
      if (realLink) offers[0].link = realLink;
    } catch (e) {
      console.warn(`Could not resolve direct link for ${part.label}:`, e.message);
    }
  }

  return offers;
}

async function resolveMerchantLink(immersiveToken, preferredSite) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_immersive_product");
  url.searchParams.set("page_token", immersiveToken);
  url.searchParams.set("api_key", SERPAPI_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "(could not read body)");
    console.warn(`  google_immersive_product lookup HTTP error: ${res.status} — body: ${bodyText.slice(0, 300)}`);
    return null;
  }
  const data = await res.json();

  if (data.error) {
    console.warn(`  google_immersive_product lookup API error: ${data.error}`);
    return null;
  }

  const sellers = data.online_sellers || data.sellers_results?.online_sellers || [];

  if (sellers.length === 0) {
    console.warn(`  No sellers found via immersive product. Response keys: ${Object.keys(data).join(', ')}`);
    return null;
  }

  const match = sellers.find(s => (s.name || "").toLowerCase().includes((preferredSite || "").toLowerCase()))
    || sellers[0];

  const resolvedLink = match?.link || match?.direct_link || null;
  if (!resolvedLink) {
    console.warn(`  Seller matched (${match?.name}) but had no usable link field. Keys: ${Object.keys(match || {}).join(', ')}`);
  }
  return resolvedLink;
}

function parsePrice(str) {
  const match = String(str).replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

async function main() {
  const partsRaw = await readFile(new URL("../parts.json", import.meta.url), "utf-8");
  const parts = JSON.parse(partsRaw);

  const output = {
    updatedAt: new Date().toISOString(),
    parts: {},
  };

  for (const part of parts) {
    console.log(`Fetching offers for: ${part.label}`);
    try {
      const offers = await fetchOffersForPart(part);
      output.parts[part.id] = {
        label: part.label,
        query: part.query,
        offers,
      };
    } catch (err) {
      console.error(`Failed for ${part.label}:`, err.message);
      output.parts[part.id] = {
        label: part.label,
        query: part.query,
        offers: [],
        error: err.message,
      };
    }
    // Small delay so we don't hammer the API back-to-back.
    await new Promise((r) => setTimeout(r, 1000));
  }

  await writeFile(
    new URL("../prices.json", import.meta.url),
    JSON.stringify(output, null, 2)
  );

  console.log("Done. Wrote prices.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
