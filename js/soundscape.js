/**
 * Soundscape Loop Creator — Main App
 * UI state, layer management, search, and transport controls.
 */

const App = (() => {
  let layers = [];
  let nextLayerId = 1;
  let loopLength = 120; // seconds
  let renderedBuffer = null;
  let searchResults = [];
  let loadingBuffers = new Map(); // sampleId -> Promise<AudioBuffer>
  let reRenderTimeout = null;
  let isRendering = false;

  // DOM refs (set in init)
  let dom = {};

  function init() {
    dom = {
      apiKey: document.getElementById('api-key'),
      apiKeySection: document.getElementById('api-key-section'),
      apiKeyToggle: document.getElementById('api-key-toggle'),
      loopSlider: document.getElementById('loop-length'),
      loopInput: document.getElementById('loop-length-input'),
      searchInput: document.getElementById('search-input'),
      searchBtn: document.getElementById('search-btn'),
      automagicBtn: document.getElementById('automagic-btn'),
      searchResults: document.getElementById('search-results'),
      layerStack: document.getElementById('layer-stack'),
      playBtn: document.getElementById('play-btn'),
      exportBtn: document.getElementById('export-btn'),
      status: document.getElementById('status'),
      searchStatus: document.getElementById('search-status'),
      layerCount: document.getElementById('layer-count'),
      creditsText: document.getElementById('credits-text'),
      creditsDownload: document.getElementById('credits-download'),
    };

    // Restore API key
    const savedKey = Freesound.getApiKey();
    if (savedKey) {
      dom.apiKey.value = savedKey;
      dom.apiKeySection.classList.add('collapsed');
    }

    // API key events
    dom.apiKey.addEventListener('change', () => {
      Freesound.setApiKey(dom.apiKey.value);
      if (dom.apiKey.value.trim()) {
        dom.apiKeySection.classList.add('collapsed');
      }
    });

    dom.apiKeyToggle.addEventListener('click', () => {
      dom.apiKeySection.classList.toggle('collapsed');
    });

    // Loop length slider + text input
    dom.loopSlider.addEventListener('input', () => {
      loopLength = parseInt(dom.loopSlider.value);
      dom.loopInput.value = formatTime(loopLength);
      clampLayersToLoopLength();
      markDirty();
      renderLayers();
    });
    dom.loopInput.addEventListener('change', () => {
      const parsed = parseTime(dom.loopInput.value);
      if (parsed !== null && parsed >= 10 && parsed <= 900) {
        loopLength = parsed;
        dom.loopSlider.value = loopLength;
        dom.loopInput.value = formatTime(loopLength);
        clampLayersToLoopLength();
        markDirty();
        renderLayers();
      } else {
        dom.loopInput.value = formatTime(loopLength);
      }
    });
    dom.loopInput.value = formatTime(loopLength);

    // Search
    dom.searchBtn.addEventListener('click', doSearch);
    dom.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // Automagic
    dom.automagicBtn.addEventListener('click', doAutomagic);

    // Transport (merged play/stop)
    dom.playBtn.addEventListener('click', togglePlay);
    dom.exportBtn.addEventListener('click', doExport);

    // Credits download
    dom.creditsDownload.addEventListener('click', downloadCredits);

    setStatus('');
  }

  // --- Search ---

  async function doSearch() {
    const query = dom.searchInput.value.trim();
    if (!query) return;

    dom.searchBtn.disabled = true;
    dom.automagicBtn.disabled = true;
    dom.searchStatus.textContent = 'Searching...';
    dom.searchResults.innerHTML = '';

    try {
      const { count, results } = await Freesound.search(query, 1, 30);
      searchResults = results;
      dom.searchStatus.textContent = `${count} results (showing ${results.length})`;
      renderSearchResults(results);
    } catch (err) {
      dom.searchStatus.textContent = `Error: ${err.message}`;
    } finally {
      dom.searchBtn.disabled = false;
      dom.automagicBtn.disabled = false;
    }
  }

  let activePreviewBtn = null;

  function resetPreviewBtn() {
    if (activePreviewBtn) {
      activePreviewBtn.textContent = '\u25B6';
      activePreviewBtn = null;
    }
  }

  function renderSearchResults(results) {
    dom.searchResults.innerHTML = '';
    for (const sample of results) {
      const card = document.createElement('div');
      card.className = 'search-card';
      card.innerHTML = `
        <div class="search-card-info">
          <div class="search-card-name" title="${escHtml(sample.name)}">${escHtml(sample.name)}</div>
          <div class="search-card-meta">${sample.duration.toFixed(1)}s &middot; ${escHtml(sample.username)} &middot; ${shortLicense(sample.license)}</div>
        </div>
        <div class="search-card-actions">
          <button class="btn-icon preview-btn" title="Preview">&#9654;</button>
          <button class="btn-icon add-btn" title="Add to layers">+</button>
        </div>
      `;

      const previewBtn = card.querySelector('.preview-btn');
      const addBtn = card.querySelector('.add-btn');

      previewBtn.addEventListener('click', async () => {
        // If this button is already playing, stop it
        if (activePreviewBtn === previewBtn) {
          AudioEngine.stopPreview();
          return; // resetPreviewBtn called via onEnded
        }

        try {
          resetPreviewBtn();
          previewBtn.textContent = '...';
          const buffer = await getOrLoadBuffer(sample);
          activePreviewBtn = previewBtn;
          previewBtn.textContent = '\u{23F8}'; // pause icon
          AudioEngine.previewSample(buffer, () => resetPreviewBtn());
        } catch (err) {
          previewBtn.textContent = '!';
          console.error('Preview failed:', err);
        }
      });

      addBtn.addEventListener('click', () => addLayer(sample));

      dom.searchResults.appendChild(card);
    }
  }

  // --- Automagic ---

  async function doAutomagic() {
    if (searchResults.length === 0) {
      await doSearch();
    }
    if (searchResults.length === 0) return;

    setStatus('Assembling...');

    // Separate locked and unlocked layers
    const locked = layers.filter(l => l.locked);
    const unlocked = layers.filter(l => !l.locked);
    const lockedIds = new Set(locked.map(l => l.sampleId));

    // Keep roughly half of unlocked layers at random
    const shuffledUnlocked = [...unlocked].sort(() => Math.random() - 0.5);
    const keepCount = Math.floor(shuffledUnlocked.length / 2);
    const kept = shuffledUnlocked.slice(0, keepCount);
    const keptIds = new Set(kept.map(l => l.sampleId));
    const usedIds = new Set([...lockedIds, ...keptIds]);

    // Randomize kept layers' volume and offset
    for (const layer of kept) {
      layer.volume = 0.3 + Math.random() * 0.5;
      layer.loopOffset = layer.loop
        ? 0
        : Math.random() * Math.max(0, loopLength - layer.duration);
    }

    layers = [...locked, ...kept];

    // Scale target count with loop length: 3 for short, up to 9 for long
    const baseCount = Math.round(3 + 6 * Math.min(1, loopLength / 600));
    const totalTarget = Math.min(searchResults.length, baseCount);
    const slotsToFill = Math.max(0, totalTarget - layers.length);

    // Available samples not already in use
    const available = searchResults.filter(s => !usedIds.has(s.id));

    // Shuffle available, then pick a mix of short and long samples.
    // Shuffle biased toward relevance: earlier results more likely to appear first.
    const shuffled = [...available].sort(() => Math.random() - 0.35);
    const shortPool = shuffled.filter(s => s.duration < loopLength * 0.3);
    const longPool = shuffled.filter(s => s.duration >= loopLength * 0.3);

    const selected = [];
    let si = 0, li = 0;
    for (let i = 0; i < slotsToFill && (si < shortPool.length || li < longPool.length); i++) {
      const wantShort = i % 2 === 0;
      if (wantShort && si < shortPool.length) {
        selected.push(shortPool[si++]);
      } else if (li < longPool.length) {
        selected.push(longPool[li++]);
      } else if (si < shortPool.length) {
        selected.push(shortPool[si++]);
      }
    }

    // Volume scaling based on total layer count
    const totalLayers = layers.length + selected.length;
    const volumeBudget = Math.min(1.0, 1.5 / Math.sqrt(totalLayers));

    for (const sample of selected) {
      const layer = addLayer(sample, true);
      if (layer) {
        layer.loop = sample.duration < loopLength * 0.4;
        layer.loopOffset = layer.loop
          ? 0
          : Math.random() * Math.max(0, loopLength - sample.duration);
        layer.volume = volumeBudget * (0.5 + Math.random() * 0.5);
        if (!layer.loop) layer.volume *= 0.7;
      }
    }

    markDirty();
    renderLayers();
    setStatus(`${locked.length} locked, ${kept.length} kept, ${selected.length} new`);
  }

  // --- Layer Management ---

  function addLayer(sample, silent = false) {
    // Don't add duplicates
    if (layers.find(l => l.sampleId === sample.id)) {
      if (!silent) setStatus(`"${sample.name}" is already in layers.`);
      return null;
    }

    const layer = {
      id: nextLayerId++,
      sampleId: sample.id,
      name: sample.name,
      username: sample.username,
      duration: sample.duration,
      license: sample.license,
      freesoundUrl: sample.freesoundUrl,
      waveform: sample.waveform,
      previewUrl: sample.previewUrl,
      volume: 0.6 + Math.random() * 0.3,
      loopOffset: 0, // set below
      trimStart: 0,
      trimLength: Math.min(sample.duration, loopLength),
      loop: sample.duration < loopLength * 0.5,
      muted: false,
      locked: false,
      buffer: null,
    };

    // Set loopOffset: for one-shots, ensure sample fits within loop
    if (layer.loop) {
      layer.loopOffset = 0;
    } else {
      const maxOffset = Math.max(0, loopLength - layer.trimLength);
      layer.loopOffset = Math.random() * maxOffset;
    }

    layers.push(layer);
    markDirty();

    if (!silent) {
      renderLayers();
      setStatus(`Added "${sample.name}"`);
    }

    // Start loading the buffer
    loadLayerBuffer(layer);

    return layer;
  }

  async function loadLayerBuffer(layer) {
    try {
      const buffer = await getOrLoadBuffer({
        id: layer.sampleId,
        previewUrl: layer.previewUrl,
      });
      layer.buffer = buffer;
      // Update the card to show loaded state
      const card = document.querySelector(`[data-layer-id="${layer.id}"]`);
      if (card) {
        card.classList.remove('loading');
        card.classList.add('loaded');
      }
    } catch (err) {
      console.error(`Failed to load sample ${layer.sampleId}:`, err);
    }
  }

  async function getOrLoadBuffer(sample) {
    if (loadingBuffers.has(sample.id)) {
      return loadingBuffers.get(sample.id);
    }
    const promise = AudioEngine.loadSample(Freesound.proxyUrl(sample.previewUrl));
    loadingBuffers.set(sample.id, promise);
    return promise;
  }

  function clampLayersToLoopLength() {
    for (const layer of layers) {
      const maxLen = Math.min(layer.duration - layer.trimStart, loopLength);
      if (layer.trimLength > maxLen) {
        layer.trimLength = maxLen;
      }
    }
  }

  function removeLayer(id) {
    layers = layers.filter(l => l.id !== id);
    markDirty();
    renderLayers();
  }

  function renderLayers() {
    dom.layerStack.innerHTML = '';
    dom.layerCount.textContent = `${layers.length} layer${layers.length !== 1 ? 's' : ''}`;

    if (layers.length === 0) {
      dom.layerStack.innerHTML = '<div class="empty-layers">Search and add sounds to build your soundscape.</div>';
      updateCredits();
      return;
    }

    for (const layer of layers) {
      const card = document.createElement('div');
      card.className = `layer-card ${layer.loop ? 'looping' : 'oneshot'} ${layer.muted ? 'muted' : ''} ${layer.buffer ? 'loaded' : 'loading'}`;
      card.dataset.layerId = layer.id;

      card.innerHTML = `
        <div class="layer-header">
          <div class="layer-name" title="${escHtml(layer.name)}">${escHtml(layer.name)}</div>
          <div class="layer-actions">
            <button class="btn-icon lock-btn ${layer.locked ? 'locked' : ''}" title="${layer.locked ? 'Unlock (automagic can replace)' : 'Lock (automagic will keep)'}">${layer.locked
              ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="8" height="6" rx="1"/><path d="M5 6V4a2 2 0 014 0v2"/></svg>'
              : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="8" height="6" rx="1"/><path d="M5 6V4a2 2 0 014 0" /></svg>'
            }</button>
            <button class="btn-icon solo-btn" title="Solo">S</button>
            <button class="btn-icon mute-btn ${layer.muted ? 'active' : ''}" title="${layer.muted ? 'Unmute' : 'Mute'}">M</button>
            <button class="btn-icon remove-btn" title="Remove"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3.5h10M5 3.5V2.5a1 1 0 011-1h2a1 1 0 011 1v1M3.5 3.5l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8M5.5 6v4M8.5 6v4"/></svg></button>
          </div>
        </div>
        ${layer.waveform ? (() => {
          const startPct = (layer.trimStart / layer.duration) * 100;
          const lengthPct = (layer.trimLength / layer.duration) * 100;
          const rightPct = 100 - startPct - lengthPct;
          return `<div class="waveform-wrap" data-layer-id="${layer.id}" style="--trim-left:${startPct}%;--trim-right:${rightPct}%">
          <img class="layer-waveform" src="${Freesound.proxyUrl(layer.waveform)}" alt="waveform">
          <div class="waveform-region" style="left:${startPct}%;width:${lengthPct}%"></div>
          <div class="waveform-progress"></div>
        </div>`;
        })() : ''}
        <div class="layer-controls">
          <label>
            <span>Volume</span>
            <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="${layer.volume}">
          </label>
          <label>
            <span>Length: ${layer.trimLength.toFixed(1)}s</span>
            <input type="range" class="length-slider" min="0.5" max="${Math.min(layer.duration - layer.trimStart, loopLength)}" step="0.1" value="${layer.trimLength}">
          </label>
          <label>
            <span>Offset: ${layer.loopOffset.toFixed(1)}s</span>
            <input type="range" class="offset-slider" min="0" max="${Math.max(0, loopLength - layer.trimLength)}" step="0.1" value="${layer.loopOffset}">
          </label>
          <div class="loop-toggle-btns">
            <button class="btn-toggle ${!layer.loop ? 'active' : ''}" data-mode="once">Play once</button>
            <button class="btn-toggle ${layer.loop ? 'active' : ''}" data-mode="loop">Loop</button>
          </div>
        </div>
        <div class="layer-provenance">
          ${layer.duration.toFixed(1)}s &middot;
          <a href="${escHtml(layer.freesoundUrl)}" target="_blank" rel="noopener">#${layer.sampleId}</a>
          by ${escHtml(layer.username)} &middot; ${shortLicense(layer.license)}
        </div>
      `;

      // Events
      card.querySelector('.lock-btn').addEventListener('click', () => {
        layer.locked = !layer.locked;
        renderLayers();
      });

      card.querySelector('.solo-btn').addEventListener('click', () => {
        // If this is already the only unmuted layer, unsolo (unmute all)
        const othersAllMuted = layers.every(l => l === layer || l.muted);
        if (othersAllMuted) {
          layers.forEach(l => l.muted = false);
        } else {
          layers.forEach(l => l.muted = (l !== layer));
        }
        markDirty();
        renderLayers();
      });

      card.querySelector('.mute-btn').addEventListener('click', () => {
        layer.muted = !layer.muted;
        markDirty();
        renderLayers();
      });

      card.querySelector('.remove-btn').addEventListener('click', () => removeLayer(layer.id));

      card.querySelector('.volume-slider').addEventListener('input', (e) => {
        layer.volume = parseFloat(e.target.value);
        markDirty();
      });

      card.querySelector('.length-slider').addEventListener('input', (e) => {
        layer.trimLength = parseFloat(e.target.value);
        // Clamp so trimStart + trimLength doesn't exceed duration or loop length
        const maxLen = Math.min(layer.duration - layer.trimStart, loopLength);
        if (layer.trimLength > maxLen) {
          layer.trimLength = maxLen;
        }
        const label = card.querySelector('.length-slider').closest('label').querySelector('span');
        label.textContent = `Length: ${layer.trimLength.toFixed(1)}s`;
        updateWaveformRegion(card, layer);
        markDirty();
      });

      card.querySelector('.offset-slider').addEventListener('input', (e) => {
        layer.loopOffset = parseFloat(e.target.value);
        const maxOff = Math.max(0, loopLength - layer.trimLength);
        if (layer.loopOffset > maxOff) layer.loopOffset = maxOff;
        const label = card.querySelector('.offset-slider').closest('label').querySelector('span');
        label.textContent = `Offset: ${layer.loopOffset.toFixed(1)}s`;
        markDirty();
      });

      card.querySelectorAll('.btn-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          layer.loop = btn.dataset.mode === 'loop';
          markDirty();
          renderLayers();
        });
      });

      const waveWrap = card.querySelector('.waveform-wrap');
      if (waveWrap) {
        waveWrap.style.cursor = 'crosshair';
        waveWrap.addEventListener('click', (e) => {
          const rect = waveWrap.getBoundingClientRect();
          const clickFrac = (e.clientX - rect.left) / rect.width;
          layer.trimStart = clickFrac * layer.duration;
          // Clamp trimLength to remaining sample and loop length
          const maxLength = Math.min(layer.duration - layer.trimStart, loopLength);
          if (layer.trimLength > maxLength) {
            layer.trimLength = maxLength;
          }
          updateWaveformRegion(card, layer);
          // Update the length slider max and value
          const lengthSlider = card.querySelector('.length-slider');
          lengthSlider.max = maxLength;
          lengthSlider.value = layer.trimLength;
          const label = lengthSlider.closest('label').querySelector('span');
          label.textContent = `Length: ${layer.trimLength.toFixed(1)}s`;
          markDirty();
        });
      }

      dom.layerStack.appendChild(card);
    }

    updateCredits();
  }

  // --- Transport ---

  async function togglePlay() {
    if (AudioEngine.getIsPlaying()) {
      AudioEngine.stopLoop();
      AudioEngine.stopPreview();
      stopProgressAnimation();
      dom.playBtn.textContent = '\u25B6 Play';
      setStatus('');
      return;
    }

    if (layers.length === 0) {
      setStatus('Add some layers first.');
      return;
    }

    // Wait for unloaded samples with visual feedback
    const unloaded = layers.filter(l => !l.buffer && !l.muted);
    if (unloaded.length > 0) {
      dom.playBtn.disabled = true;
      dom.playBtn.textContent = '\u23F3 Wait';
      setStatus(`Loading ${unloaded.length} sample${unloaded.length > 1 ? 's' : ''}...`);
      await Promise.all(unloaded.map(l => loadLayerBuffer(l)));
    }

    dom.playBtn.disabled = true;
    dom.exportBtn.disabled = true;
    dom.playBtn.textContent = '\u23F3 Wait';
    setStatus('Rendering...');

    try {
      renderedBuffer = await AudioEngine.renderLoop(layers, loopLength, (p) => {
        setStatus(`Rendering... ${Math.round(p * 100)}%`);
      });
      AudioEngine.playLoop(renderedBuffer);
      startProgressAnimation();
      setStatus('Playing');
      dom.playBtn.textContent = '\u25A0 Stop';
      dom.playBtn.disabled = false;
      dom.exportBtn.disabled = false;
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      dom.playBtn.textContent = '\u25B6 Play';
      dom.playBtn.disabled = false;
      console.error(err);
    }
  }

  async function doExport() {
    if (layers.length === 0) {
      setStatus('Add some layers first.');
      return;
    }

    dom.exportBtn.disabled = true;
    setStatus('Rendering for export...');

    try {
      // Always re-render for export to get latest settings
      const buffer = await AudioEngine.renderLoop(layers, loopLength, (p) => {
        setStatus(`Rendering... ${Math.round(p * 100)}%`);
      });

      const biome = dom.searchInput.value.trim().replace(/\s+/g, '-') || 'soundscape';
      AudioEngine.exportWav(buffer, `${biome}-loop-${loopLength}s.wav`);
      setStatus('WAV exported!');
    } catch (err) {
      setStatus(`Export error: ${err.message}`);
      console.error(err);
    } finally {
      dom.exportBtn.disabled = false;
    }
  }

  // --- Live Update ---

  /**
   * Mark the mix as dirty. If currently playing, debounce a re-render and hot-swap.
   */
  function markDirty() {
    renderedBuffer = null;
    if (!AudioEngine.getIsPlaying()) return;

    clearTimeout(reRenderTimeout);
    reRenderTimeout = setTimeout(async () => {
      if (!AudioEngine.getIsPlaying() || isRendering) return;
      isRendering = true;
      setStatus('Re-rendering...');
      try {
        const unloaded = layers.filter(l => !l.buffer && !l.muted);
        if (unloaded.length > 0) {
          await Promise.all(unloaded.map(l => loadLayerBuffer(l)));
        }
        renderedBuffer = await AudioEngine.renderLoop(layers, loopLength);
        AudioEngine.playLoop(renderedBuffer);
        startProgressAnimation();
        dom.playBtn.textContent = '\u25A0 Stop';
        setStatus('Playing');
      } catch (err) {
        setStatus(`Re-render error: ${err.message}`);
        console.error(err);
      } finally {
        isRendering = false;
      }
    }, 600);
  }

  // --- Credits ---

  function updateCredits() {
    const text = getCreditsText();
    dom.creditsText.value = text;
    dom.creditsDownload.disabled = layers.length === 0;
  }

  function getCreditsText() {
    const activeLayers = layers.filter(l => !l.muted);
    if (activeLayers.length === 0) return '';

    const lines = [];
    for (const layer of activeLayers) {
      lines.push(`"${layer.name}" by ${layer.username}`);
      lines.push(`  License: ${layer.license || 'Unknown'}`);
      lines.push(`  Source: ${layer.freesoundUrl}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  function downloadCredits() {
    const text = getCreditsText();
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const biome = dom.searchInput.value.trim().replace(/\s+/g, '-') || 'soundscape';
    a.download = `${biome}-credits.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function shortLicense(license) {
    if (!license) return '?';
    const l = license.toLowerCase();
    if (l.includes('zero') || l.includes('/publicdomain/') || l.includes('cc0')) return 'CC0';
    if (l.includes('by-nc-sa')) return 'CC BY-NC-SA';
    if (l.includes('by-nc-nd')) return 'CC BY-NC-ND';
    if (l.includes('by-nc') || l.includes('noncommercial')) return 'CC BY-NC';
    if (l.includes('by-sa')) return 'CC BY-SA';
    if (l.includes('by-nd')) return 'CC BY-ND';
    if (l.includes('by') || l.includes('attribution')) return 'CC BY';
    if (l.includes('sampling')) return 'Sampling+';
    return license.replace(/https?:\/\/creativecommons\.org\/licenses\//, '').replace(/\/$/, '');
  }

  function updateWaveformRegion(card, layer) {
    const wrap = card.querySelector('.waveform-wrap');
    if (!wrap) return;
    const startPct = (layer.trimStart / layer.duration) * 100;
    const lengthPct = (layer.trimLength / layer.duration) * 100;
    const region = wrap.querySelector('.waveform-region');
    if (region) {
      region.style.left = `${startPct}%`;
      region.style.width = `${lengthPct}%`;
    }
    // Set CSS vars for the dimming overlays
    wrap.style.setProperty('--trim-left', `${startPct}%`);
    wrap.style.setProperty('--trim-right', `${100 - startPct - lengthPct}%`);
  }

  // --- Playback Progress Animation ---

  let animFrameId = null;

  function startProgressAnimation() {
    if (animFrameId) return;
    function tick() {
      if (!AudioEngine.getIsPlaying()) {
        stopProgressAnimation();
        return;
      }
      const loopTime = AudioEngine.getLoopTime();

      for (const layer of layers) {
        const wrap = document.querySelector(`.waveform-wrap[data-layer-id="${layer.id}"]`);
        if (!wrap) continue;
        const line = wrap.querySelector('.waveform-progress');
        if (!line) continue;

        let sampleFrac = -1; // -1 means not currently playing

        const tStart = layer.trimStart || 0;
        const tLen = layer.trimLength || layer.duration;
        const lOff = layer.loopOffset || 0;

        if (layer.muted || tLen <= 0) {
          sampleFrac = -1;
        } else if (layer.loop) {
          // Looping: trimmed segment repeats from loopOffset onward
          const elapsed = loopTime - lOff;
          const segTime = ((elapsed % tLen) + tLen) % tLen;
          sampleFrac = (tStart + segTime) / layer.duration;
        } else {
          // One-shot: plays trimmed segment once at loopOffset
          const elapsed = loopTime - lOff;
          if (elapsed >= 0 && elapsed < tLen) {
            sampleFrac = (tStart + elapsed) / layer.duration;
          }
        }

        if (sampleFrac >= 0 && sampleFrac <= 1) {
          line.style.left = `${sampleFrac * 100}%`;
          line.style.opacity = '1';
        } else {
          line.style.opacity = '0';
        }
      }

      animFrameId = requestAnimationFrame(tick);
    }
    animFrameId = requestAnimationFrame(tick);
  }

  function stopProgressAnimation() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    document.querySelectorAll('.waveform-progress').forEach(el => {
      el.style.left = '0%';
      el.style.opacity = '0';
    });
  }

  // --- Helpers ---

  function setStatus(msg) {
    if (dom.status) dom.status.textContent = msg;
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  /** Parse user input like "2m 30s", "2:30", "150", "2m" into seconds. */
  function parseTime(str) {
    str = str.trim().toLowerCase();
    // "2m 30s" or "2m30s"
    const ms = str.match(/(\d+)\s*m\s*(\d*)\s*s?/);
    if (ms) return parseInt(ms[1]) * 60 + (parseInt(ms[2]) || 0);
    // "2:30"
    const colon = str.match(/^(\d+):(\d+)$/);
    if (colon) return parseInt(colon[1]) * 60 + parseInt(colon[2]);
    // plain seconds "150" or "150s"
    const plain = str.match(/^(\d+)\s*s?$/);
    if (plain) return parseInt(plain[1]);
    return null;
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { layers, addLayer, removeLayer };
})();
