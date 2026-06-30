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
  handlePayload(event.data.payload, event.data.videoUrls || [], event.data.adLibIds || [], event.data.pageIds || [], event.data.imageUrls || [], event.data.rawCtaUrl || null);
});

// ─── PARSE NDJSON ─────────────────────────────────────────────────────────────
function parseNDJSON(text) {
  const items = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try { items.push(JSON.parse(trimmed)); } catch {}
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
    if (JSON.stringify(sections).includes("SponsoredData")) nodes.push(node);
  }
  for (const item of items) {
    try {
      if (item?.data?.node) checkNode(item.data.node);
      const edges = item?.data?.viewer?.news_feed?.edges;
      if (Array.isArray(edges)) edges.forEach(e => checkNode(e?.node));
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
    const actors = deepGet(contextStory, "actors") || deepGet(contentStory, "actors") || [];
    const actor = Array.isArray(actors) ? actors[0] : null;
    const pageName = actor?.name || deepGet(node, "name") || "";
    const pageProfile = deepGet(node, "page_profile") || deepGet(contentStory, "page_profile") || deepGet(contextStory, "page_profile") || {};
    const pageId = pageProfile.id || actor?.id || "";
    const pageLogo = pageId ? `https://graph.facebook.com/${pageId}/picture?type=square` : "";

    // ── Ad Library ID ────────────────────────────────────────────────────────
    const adLibraryId =
      deepGet(node, "ad_id") || deepGet(node, "adLibraryId") || deepGet(node, "ad_archive_id") || deepGet(node, "adArchiveId") ||
      deepGet(sections, "ad_id") || deepGet(sections, "adLibraryId") || deepGet(sections, "ad_archive_id") ||
      deepGet(contentStory, "ad_id") || deepGet(contentStory, "adLibraryId") || deepGet(contentStory, "ad_archive_id") || "";

    // ── Copy text ────────────────────────────────────────────────────────────
    const allTexts = deepGetAll(contentStory, "text").filter(t => typeof t === "string" && t.length > 5).sort((a, b) => b.length - a.length);
    const postText = allTexts[0] || "";

    // ── Link card (footer) ───────────────────────────────────────────────────
    const linkPreview = deepGet(contentStory, "link_preview") || deepGet(contentStory, "linked_media") || {};
    const fouterTitle =
      (typeof linkPreview?.title === "string" ? linkPreview.title : "") ||
      (typeof linkPreview?.name === "string" ? linkPreview.name : "") ||
      deepGetAll(contentStory, "title").find(t => typeof t === "string" && t.length > 2) || "";
    const fouterDesc =
      (typeof linkPreview?.description === "string" ? linkPreview.description : "") ||
      deepGetAll(contentStory, "description").find(d => typeof d === "string" && d.length > 2) || "";
    const fouterUrl =
      linkPreview?.url ||
      deepGet(contentStory, "url") ||
      deepGet(contentStory, "call_to_action")?.value?.link ||
      deepGet(node, "call_to_action")?.value?.link ||
      deepGetAll(contentStory, "call_to_action").find(c => c?.value?.link)?.value?.link ||
      deepGet(contentStory, "cta_link") ||
      deepGet(node, "cta_link") ||
      "";

    // ── Creative image ───────────────────────────────────────────────────────
    const photoImages = deepGetAll(contentStory, "photo_image");
    const resizableImages = deepGetAll(contentStory, "resizable_image");
    const previewImages = deepGetAll(contentStory, "preview_image");
    const imageUri =
      photoImages.find(p => p?.uri)?.uri ||
      resizableImages.find(p => p?.uri)?.uri ||
      previewImages.find(p => p?.uri)?.uri ||
      deepGet(contentStory, "image")?.uri ||
      deepGetAll(node, "image").find(p => p?.uri)?.uri || "";

    // ── Video ─────────────────────────────────────────────────────────────────
    const videoUrl =
      deepGet(node, "playable_url_quality_hd", 20) || deepGet(node, "playable_url", 20) ||
      deepGet(node, "browser_native_hd_url", 20) || deepGet(node, "browser_native_sd_url", 20) ||
      deepGet(node, "stream_url", 20) || "";
    const thumbnailUri =
      deepGet(contentStory, "thumbnailImage")?.uri ||
      deepGet(contentStory, "preferred_thumbnail")?.image?.uri ||
      deepGet(sections, "thumbnailImage")?.uri ||
      deepGet(node, "thumbnailImage")?.uri ||
      deepGet(node, "preferred_thumbnail")?.image?.uri || "";

    // ── CTA ───────────────────────────────────────────────────────────────────
    const ctaText = deepGet(contentStory, "cta_text") || deepGet(contentStory, "call_to_action_text") || "";

    // ── Unique ID ─────────────────────────────────────────────────────────────
    const uniqueId = adLibraryId ? `fb_${adLibraryId}` : `fb_${pageId}_${Date.now()}`;
    if (seenIds.has(uniqueId)) return null;

    if (videoUrl) console.log("[OfferHub] 🎬 Video encontrado:", videoUrl.slice(0, 80));
    else console.log("[OfferHub] 🖼️ Sem vídeo para:", pageName);

    return {
      id: uniqueId,
      advertiser: pageName || "Desconhecido",
      pageId, pageLogo, adLibraryId,
      copy: postText,
      linkTitle: fouterTitle,
      linkDesc: fouterDesc,
      ctaUrl: fouterUrl || "",
      snapshotUrl: adLibraryId ? `https://www.facebook.com/ads/library/?id=${adLibraryId}` : (fouterUrl || ""),
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
    if (!hubUrl) { console.warn("[OfferHub] Hub URL não configurada."); return; }
    const { hubToken } = await chrome.storage.sync.get(["hubToken"]);
    const token = hubToken || "no-auth";
    chrome.runtime.sendMessage({ type: "SEND_TO_HUB", hubUrl, token, ads }, (response) => {
      try {
        if (chrome.runtime.lastError) return;
        if (response?.ok) {
          capturedCount += ads.length;
          try { chrome.storage.sync.set({ capturedCount }); } catch(_) {}
          try { chrome.runtime.sendMessage({ type: "ADS_CAPTURED", count: capturedCount, newAds: ads.length }); } catch(_) {}
          console.log(`[OfferHub] ✅ ${ads.length} ad(s) enviado(s) para o hub`);
        } else { console.warn("[OfferHub] Erro ao enviar:", response?.error); }
      } catch(_) {}
    });
  } catch(e) {}
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
function handlePayload(payload, rawVideoUrls = [], rawAdLibIds = [], rawPageIds = [], rawImageUrls = [], rawCtaUrl = null) {
  try {
    const items = parseNDJSON(payload);
    const sponsoredNodes = findSponsoredNodes(items);
    if (sponsoredNodes.length === 0) return;

    const availableVideos = [...rawVideoUrls];
    const availableImages = [...rawImageUrls];
    const availableAdLibIds = [...rawAdLibIds];
    const availablePageIds = [...rawPageIds];

    const ads = sponsoredNodes.map(node => {
      const ad = extractAd(node);
      if (!ad) return null;
      if (!ad.videoUrl && availableVideos.length > 0) {
        ad.videoUrl = availableVideos.shift();
        console.log("[OfferHub] 🎬 Vídeo via raw URL:", ad.advertiser, ad.videoUrl?.slice(0, 60));
      }
      if (!ad.imageUrl && availableImages.length > 0) {
        ad.imageUrl = availableImages.shift();
        console.log("[OfferHub] 🖼️ Imagem via raw URL:", ad.advertiser, ad.imageUrl?.slice(0, 60));
      }
      if (!ad.adLibraryId && availableAdLibIds.length > 0) {
        ad.adLibraryId = availableAdLibIds.shift();
        console.log("[OfferHub] 📚 adLibraryId via raw:", ad.advertiser, ad.adLibraryId);
      }
      if (!ad.pageId && availablePageIds.length > 0) {
        ad.pageId = availablePageIds.shift();
        console.log("[OfferHub] 🏷️ pageId via raw:", ad.advertiser, ad.pageId);
      }
      if (!ad.ctaUrl && rawCtaUrl) {
        ad.ctaUrl = rawCtaUrl;
        console.log("[OfferHub] 🔗 ctaUrl via raw:", ad.advertiser, rawCtaUrl.slice(0, 60));
      }
      return ad;
    }).filter(Boolean).filter(ad => {
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
