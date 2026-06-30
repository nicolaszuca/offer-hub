(function() {
  if (window.__offerHubLoaded) return;
  window.__offerHubLoaded = true;

  const OFFER_HUB_ID = "__offer_hub_xhr_listener";
  const resRegexs = ["/api/graphql"].map(e => new RegExp(e, "i"));

  console.log("[OfferHub] scripti.js carregado");

  function extractRawVideoUrls(text) {
    const urls = new Set();
    const mp4Re = /"(https?:\\/\\/[^"]{10,600}?\.mp4(?:[^"]*?)?)"/g;
    let m;
    while ((m = mp4Re.exec(text)) !== null) {
      urls.add(m[1].replace(/\\//g, '/').replace(/\\u0026/g, '&').replace(/\\u003F/gi, '?'));
    }
    const playRe = /"playable_url(?:_quality_hd)?"s*:s*"([^"]+)"/g;
    while ((m = playRe.exec(text)) !== null) {
      urls.add(m[1].replace(/\\//g, '/').replace(/\\u0026/g, '&'));
    }
    const nativeRe = /"browser_native_(?:hd|sd)_url"s*:s*"([^"]+)"/g;
    while ((m = nativeRe.exec(text)) !== null) {
      urls.add(m[1].replace(/\\//g, '/').replace(/\\u0026/g, '&'));
    }
    return Array.from(urls);
  }

  function extractSponsoredIds(text) {
    const adLibIds = [];
    const pageIds = [];
    let m;
    const archiveRe = /"(?:ad_archive_id|adLibraryId|adArchiveId|archive_id|ad_id)"s*:s*"?(\d{15,})"?/gi;
    while ((m = archiveRe.exec(text)) !== null) {
      if (!adLibIds.includes(m[1])) adLibIds.push(m[1]);
    }
    const pageRe = /"page_id"s*:s*"?(\d+)"?/g;
    while ((m = pageRe.exec(text)) !== null) {
      if (!pageIds.includes(m[1])) pageIds.push(m[1]);
    }
    return { adLibIds, pageIds };
  }

  function extractRawCtaUrl(text) {
    let m;
    // Pattern 1: named CTA link fields
    const re1 = /"(?:cta_link|link_url|destination_url|landing_url|call_to_action_link)"s*:s*"([^"]{10,800})"/g;
    while ((m = re1.exec(text)) !== null) {
      const url = m[1].replace(/\\//g, '/').replace(/\\u0026/g, '&').replace(/\\u003F/gi, '?');
      if (url.startsWith('http')) return url;
    }
    // Pattern 2: call_to_action.value.link
    const re2 = /"call_to_action"s*:s*\{[^\}]{0,300}"value"s*:s*\{[^\}]{0,300}"link"s*:s*"([^"]{10,800})"/g;
    while ((m = re2.exec(text)) !== null) {
      const url = m[1].replace(/\\//g, '/').replace(/\\u0026/g, '&').replace(/\\u003F/gi, '?');
      if (url.startsWith('http')) return url;
    }
    // Pattern 3: l.facebook.com/l.php redirect URL (CTA tracking link stored anywhere in GraphQL)
    const re3 = /"(https?:[^"]{0,10}l\.facebook\.com[^"]{0,10}l\.php\?[^"]{20,2000})"/g;
    while ((m = re3.exec(text)) !== null) {
      const url = m[1].replace(/\\//g, '/').replace(/\\u0026/g, '&').replace(/\\u003F/gi, '?');
      if (url.startsWith('http') && url.includes('l.php')) return url;
    }
    return null;
  }

  function extractRawImageUrls(text) {
    const urls = new Set();
    const imgRe = /"(?:resizable_image|photo_image|preview_image|thumbnail_image|image)"s*:s*\{[^\}]{0,300}?"uri"s*:s*"([^"]+)"/g;
    let m;
    while ((m = imgRe.exec(text)) !== null) {
      const url = m[1].replace(/\\//g, '/').replace(/\\u0026/g, '&').replace(/\\u003F/gi, '?');
      if (url.startsWith('http') && !url.includes('.mp4')) urls.add(url);
    }
    return Array.from(urls);
  }

  function postPayload(text) {
    if (
      text.includes("SponsoredData") &&
      (
        text.includes("$CometNewsFeed_viewer_news_feed") ||
        text.includes("$stream$CometVideoHomeFeedSection_section_components") ||
        text.includes("news_feed")
      )
    ) {
      const videoUrls = extractRawVideoUrls(text);
      const imageUrls = extractRawImageUrls(text);
      const { adLibIds, pageIds } = extractSponsoredIds(text);
      const rawCtaUrl = extractRawCtaUrl(text);
      console.log("[OfferHub] Ad detected | videos:", videoUrls.length, "| images:", imageUrls.length, "| adLibIds:", adLibIds.length, "| ctaUrl:", rawCtaUrl ? rawCtaUrl.slice(0, 60) : 'none');
      window.postMessage({ type: OFFER_HUB_ID, payload: text, videoUrls, imageUrls, adLibIds, pageIds, rawCtaUrl }, window.location.origin);
    }
  }

  function callback(xhr) {
    if (!resRegexs.some(r => r.test(xhr.responseURL))) return;
    const text = xhr.responseText;
    const ct = xhr.getResponseHeader("content-type") || "";
    if (text && ct.includes("text/html")) postPayload(text);
  }

  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;

  proto.open = function(method, url) {
    this._url = url;
    return origOpen.apply(this, arguments);
  };

  proto.send = function() {
    this.addEventListener("load", function() { callback(this); });
    return origSend.apply(this, arguments);
  };

  // Intercepta fetch() API — usada para Reels e outros conteudos dinamicos
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (resRegexs.some(r => r.test(url))) {
        const ct = response.headers.get('content-type') || '';
        const clone = response.clone();
        clone.text().then(text => {
          if (!text) return;
          console.log("[OfferHub] GraphQL fetch | ct:", ct.substring(0, 40), "| sponsor:", text.includes("SponsoredData"));
          if (ct.includes("text/html") || ct.includes("x-ndjson") || ct.includes("json")) {
            postPayload(text);
          }
        }).catch(() => {});
      }
    } catch(e) {}
    return response;
  };
})();
