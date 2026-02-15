/**
 * Freesound API Client
 * Handles search, metadata fetching, and URL building for Freesound samples.
 */

const Freesound = (() => {
  const API_BASE = 'https://freesound.org/apiv2';

  function getApiKey() {
    return localStorage.getItem('freesound_api_key') || '';
  }

  function setApiKey(key) {
    localStorage.setItem('freesound_api_key', key.trim());
  }

  /**
   * Search for CC0 sounds matching a query.
   * @param {string} query - Search terms
   * @param {number} page - Page number (1-based)
   * @param {number} pageSize - Results per page
   * @returns {Promise<{count: number, results: Array}>}
   */
  async function search(query, page = 1, pageSize = 15) {
    const key = getApiKey();
    if (!key) throw new Error('No Freesound API key set');

    const params = new URLSearchParams({
      query,
      fields: 'id,name,description,username,previews,duration,tags,images,license',
      page,
      page_size: pageSize,
      token: key,
    });

    const resp = await fetch(`${API_BASE}/search/text/?${params}`);
    if (!resp.ok) {
      if (resp.status === 401) throw new Error('Invalid API key');
      throw new Error(`Freesound API error: ${resp.status}`);
    }

    const data = await resp.json();
    return {
      count: data.count,
      results: data.results.map(normalizeSample),
    };
  }

  /**
   * Normalize a Freesound result into our internal format.
   */
  function normalizeSample(raw) {
    // Pick the best preview URL available
    const previews = raw.previews || {};
    const previewUrl =
      previews['preview-hq-ogg'] ||
      previews['preview-hq-mp3'] ||
      previews['preview-lq-ogg'] ||
      previews['preview-lq-mp3'] ||
      '';

    // Waveform image
    const waveform = raw.images?.waveform_l || raw.images?.waveform_m || '';

    return {
      id: raw.id,
      name: raw.name,
      description: raw.description || '',
      username: raw.username,
      duration: raw.duration,
      tags: raw.tags || [],
      license: raw.license || '',
      previewUrl,
      waveform,
      freesoundUrl: `https://freesound.org/people/${raw.username}/sounds/${raw.id}/`,
    };
  }

  /**
   * Build a proxied URL for fetching audio data (bypasses CORS).
   */
  function proxyUrl(url) {
    return `/proxy?url=${encodeURIComponent(url)}`;
  }

  return { getApiKey, setApiKey, search, proxyUrl };
})();
