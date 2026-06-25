(function() {
  if (window.__offerHubLoaded) return;
  window.__offerHubLoaded = true;

  const OFFER_HUB_ID = "__offer_hub_xhr_listener";
  const resRegexs = ["/api/graphql"].map(e => new RegExp(e, "i"));

  console.log("[OfferHub] 🚀 scripti.js carregado");

  // Extrai URLs de video do CDN do Facebook diretamente do texto bruto (JSON-encoded)
  // Cobre Reels e videos onde playable_url nao aparece no no GraphQL principal
  function extractRawVideoUrls(text) {
    const urls = new Set();
    // Padrao 1: URLs diretas de .mp4 no JSON (barras escapadas como \/)
    const mp4Re = /"(https?:\\\/\\\/[^"]{10,600}?\.mp4(?:[^"]*?)?)"/g;
    let m;
    while ((m = mp4Re.exec(text)) !== null) {
      urls.add(m[1].replace(/\\\/g, '/').replace(/\\u0026/g, '&').replace(/\\u003F/gi, '?'));
    }
    // Padrao 2: playable_url com barras normais
    const playRe = /"playable_url(?:_quality_hd)?"s*:s*"([^"]+)"/g;
    while ((m = playRe.exec(text)) !== null) {
      urls.add(m[1].replace(/\\\/g, '/').replace(/\\u0026/g, '&'));
    }
    // Padrao 3: browser_native_hd_url / browser_native_sd_url
    const nativeRe = /"browser_native_(?:hd|sd)_url"s*:s*"([^"]+)"/g;
    while ((m = nativeRe.exec(text)) !== null) {
      urls.add(m[1].replace(/\\\/g, '/').replace(/\\u0026/g, '&'));
    }
    return Array.from(urls);
  }

  // Extrai ad_archive_id (= adLibraryId) e page_id do texto bruto do GraphQL
  function extractSponsoredIds(text) {
    const adLibIds = [];
    const pageIds = [];
    let m;
    // Busca todos os possiveis nomes do campo de ID da biblioteca de anuncios
    // O valor pode vir com ou sem aspas, minimo 15 digitos
    const archiveRe = /"(?:ad_archive_id|adLibraryId|adArchiveId|archive_id)"\s*:\s*"?(\d{15,})"?/gi;
    while ((m = archiveRe.exec(text)) !== null) {
      if (!adLibIds.includes(m[1])) adLibIds.push(m[1]);
    }
    const pageRe = /"page_id"\s*:\s*"?(\d+)"?/g;
    while ((m = pageRe.exec(text)) !== null) {
      if (!pageIds.includes(m[1])) pageIds.push(m[1]);
    }
    return { adLibIds, pageIds };
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
      const { adLibIds, pageIds } = extractSponsoredIds(text);
      console.log("[OfferHub] Anuncio detectado | videos:", videoUrls.length, "| adLibIds:", adLibIds.length, "| pageIds:", pageIds.length);
      window.postMessage({ type: OFFER_HUB_ID, payload: text, videoUrls, adLibIds, pageIds }, window.location.origin);
    }
  }

  function callback(xhr) {
    if (!resRegexs.some(r => r.test(xhr.responseURL))) return;
    const text = xhr.responseText;
    const ct = xhr.getResponseHeader("content-type") || "";
    console.log("[OfferHub] GraphQL XHR | ct:", ct.substring(0, 40), "| sponsor:", text.includes("SponsoredData"));
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
})();
