// Offer Hub Collector - Content Script
// Listens for intercepted Facebook GraphQL responses, extracts sponsored ad data,
// deduplicates, and sends to the configured hub API.

const MSG_ID = "__offer_hub_xhr_listener";
const seenIds = new Set();
let hubUrl = "";
let capturedCount = 0;

// ─── STORAGE ──────────────────────────────────────────────────────────────────
chrome.storage.sync.get(["hubUrl", "capturedCount"], (data) => {
  hubUrl = (data.hubUrl || "").replace(/\/$/, "");
  capturedCount = data.capturedCount || 0;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.hubUrl) hubUrl = (changes.hubUrl.newValue || "").replace(/\/$/, "");
});

// ─── LISTEN FOR XHR PAYLOADS ──────────────────────────────────────────────────
window.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== MSG_ID) return;
  handlePayload(event.data.payload, event.data.videoUrls || []);
});

// ─── PARSE NDJSON ─────────────────────────────────────────────────────────────
// Facebook returns newline-delimited JSON (one JSON object per line)
function parseNDJSON(text) {
  const items = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {}
  }
  return items;
}

// ─── FIND SPONSORED NODES ─────────────────────────────────────────────────────
function findSponsoredNodes(items) {
  const nodes = [];

  function checkNode(node) {
    if (!node || typeof node !== "object") return;
    const sections = node.comet_sections;
    if (!sections) return;
    const str = JSON.stringify(sections);
    if (str.includes("SponsoredData")) nodes.push(node);
  }

  for (const item of items) {
    try {
      // Pattern 1: data.node (single post)
      if (item?.data?.node) checkNode(item.data.node);

      // Pattern 2: data.viewer.news_feed.edges (feed)
      const edges = item?.data?.viewer?.news_feed?.edges;
      if (Array.isArray(edges)) edges.forEach(e => checkNode(e?.node));

      // Pattern 3: data.viewer.home_stream.edges
      const streamEdges = item?.data?.viewer?.home_stream?.edges;
      if (Array.isArray(streamEdges)) streamEdges.forEach(e => checkNode(e?.node));
    } catch {}
  }

  return nodes;
}

// ─── DEEP GET HELPERS ─────────────────────────────────────────────────────────
function deepGet(obj, key, maxDepth = 15) {
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const r = deepGet(v, key, maxDepth - 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function deepGetAll(obj, key, maxDepth = 12, results = []) {
  if (!obj || typeof obj !== "object" || maxDepth <= 0) return results;
  if (key in obj && obj[key] !== null) results.push(obj[key]);
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") deepGetAll(v, key, maxDepth - 1, results);
  }
  return results;
}

// ─── EXTRACT AD DATA ──────────────────────────────────────────────────────────
function extractAd(node) {
  try {
    const sections = node.comet_sections || {};
    const contentStory = sections.content?.story || {};
    const contextStory = sections.context_layout?.story || {};

    // ── Advertiser ───────────────────────────────────────────────────────────
    // actors is usually on context_layout.story or content.story
    const actors = deepGet(contextStory, "actors") || deepGet(contentStory, "actors") || [];
    const actor = Array.isArray(actors) ? actors[0] : null;
    const pageName = actor?.name || deepGet(node, "name") || "";
    // page_profile.id é o ID público da página (usado no Ad Library)
    // actor.id pode ser um ID interno de conta de negócio
    const pageProfile = deepGet(node, "page_profile") || deepGet(contentStory, "page_profile") || deepGet(contextStory, "page_profile") || {};
    const pageId = pageProfile.id || actor?.id || "";

    // ── Ad Library ID ────────────────────────────────────────────────────────
    const adLibraryId =
      deepGet(node, "adLibraryId") ||
      deepGet(sections, "adLibraryId") ||
      deepGet(contentStory, "adLibraryId") ||
      "";

    // ── Copy text ────────────────────────────────────────────────────────────
    // message.text is the main copy; collect all text strings and pick longest
    const allTexts = deepGetAll(contentStory, "text")
      .filter(t => typeof t === "string" && t.length > 5)
      .sort((a, b) => b.length - a.length);
    const postText = allTexts[0] || "";

    // ── Link card (footer) ───────────────────────────────────────────────────
    const linkPreview =
      deepGet(contentStory, "link_preview") ||
      deepGet(contentStory, "linked_media") ||
      {};
    const fouterTitle =
      (typeof linkPreview?.title === "string" ? linkPreview.title : "") ||
      (typeof linkPreview?.name === "string" ? linkPreview.name : "") ||
      deepGetAll(contentStory, "title").find(t => typeof t === "string" && t.length > 2) ||
      "";
    const fouterDesc =
      (typeof linkPreview?.description === "string" ? linkPreview.description : "") ||
      deepGetAll(contentStory, "description").find(d => typeof d === "string" && d.length > 2) ||
      "";
    const fouterUrl =
      linkPreview?.url ||
      deepGet(contentStory, "url") ||
      "";

    // ── Creative image ───────────────────────────────────────────────────────
    const photoImages = deepGetAll(contentStory, "photo_image");
    const imageUri = photoImages.find(p => p?.uri)?.uri || "";

    // ── Video ─────────────────────────────────────────────────────────────────
    // Search the entire node tree with increased depth for video URLs
    const videoUrl =
      deepGet(node, "playable_url_quality_hd", 20) ||
      deepGet(node, "playable_url", 20) ||
      deepGet(node, "browser_native_hd_url", 20) ||
      deepGet(node, "browser_native_sd_url", 20) ||
      deepGet(node, "stream_url", 20) ||
      "";
    const thumbnailUri =
      deepGet(contentStory, "thumbnailImage")?.uri ||
      deepGet(contentStory, "preferred_thumbnail")?.image?.uri ||
      deepGet(sections, "thumbnailImage")?.uri ||
      deepGet(node, "thumbnailImage")?.uri ||
      deepGet(node, "preferred_thumbnail")?.image?.uri ||
      "";

    // ── CTA ───────────────────────────────────────────────────────────────────
    const ctaText =
      deepGet(contentStory, "cta_text") ||
      deepGet(contentStory, "call_to_action_text") ||
      "";

    // ── Unique ID ─────────────────────────────────────────────────────────────
    const uniqueId = adLibraryId
      ? `fb_${adLibraryId}`
      : `fb_${pageId}_${Date.now()}`;

    if (seenIds.has(uniqueId)) return null;

    if (videoUrl) console.log("[OfferHub] 🎬 Video encontrado:", videoUrl.slice(0, 80));
    else console.log("[OfferHub] 🖼️ Sem vídeo para:", pageName);

    return {
      id: uniqueId,
      advertiser: pageName || "Desconhecido",
      pageId,
      adLibraryId,
      copy: postText,
      linkTitle: fouterTitle,
      linkDesc: fouterDesc,
      snapshotUrl: adLibraryId
        ? `https://www.facebook.com/ads/library/?id=${adLibraryId}`
        : (fouterUrl || ""),
      imageUrl: imageUri || thumbnailUri,
      videoUrl,
      platforms: ["facebook", "instagram"],
      createdAt: new Date().toISOString().split("T")[0],
      addedAt: new Date().toLocaleDateString("pt-BR"),
      source: "facebook-feed",
    };
  } catch (e) {
    console.warn("[OfferHub] Extraction error:", e);
    return null;
  }
}

// ─── SEND TO HUB ──────────────────────────────────────────────────────────────
async function sendToHub(ads) {
  try {
    if (!hubUrl) {
      console.warn("[OfferHub] Hub URL não configurada. Configure no popup da extensão.");
      return;
    }

    const { hubToken } = await chrome.storage.sync.get(["hubToken"]);
    const token = hubToken || "no-auth";

    // Roteia pelo background service worker (sem restrição CORS)
    chrome.runtime.sendMessage(
      { type: "SEND_TO_HUB", hubUrl, token, ads },
      (response) => {
        try {
          if (chrome.runtime.lastError) return;
          if (response?.ok) {
            capturedCount += ads.length;
            try { chrome.storage.sync.set({ capturedCount }); } catch(_) {}
            try { chrome.runtime.sendMessage({ type: "ADS_CAPTURED", count: capturedCount, newAds: ads.length }); } catch(_) {}
            console.log(`[OfferHub] ✅ ${ads.length} ad(s) enviado(s) para o hub`);
          } else {
            console.warn("[OfferHub] Erro ao enviar:", response?.error);
          }
        } catch(_) {}
      }
    );
  } catch(e) {
    // Extension context invalidated após recarga — ignorar silenciosamente
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
function handlePayload(payload, rawVideoUrls = []) {
  try {
    const items = parseNDJSON(payload);
    const sponsoredNodes = findSponsoredNodes(items);
    if (sponsoredNodes.length === 0) return;

    // Track which raw video URLs have been assigned so we don't reuse them
    const availableVideos = [...rawVideoUrls];

    const ads = sponsoredNodes
      .map(node => {
        const ad = extractAd(node);
        if (!ad) return null;
        // If deepGet found nothing, try raw CDN URLs extracted from text
        if (!ad.videoUrl && availableVideos.length > 0) {
          ad.videoUrl = availableVideos.shift();
          console.log("[OfferHub] 🎬 Vídeo via raw URL:", ad.advertiser, ad.videoUrl?.slice(0, 60));
        }
        return ad;
      })
      .filter(Boolean)
      .filter(ad => {
        if (seenIds.has(ad.id)) return false;
        seenIds.add(ad.id);
        return true;
      });

    if (ads.length > 0) {
      console.log(`[OfferHub] 🎯 ${ads.length} anúncio(s) capturado(s):`, ads.map(a => a.advertiser));
      sendToHub(ads);
    }
  } catch (e) {
    console.warn("[OfferHub] Parse error:", e);
  }
}
