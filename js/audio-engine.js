/**
 * Audio Engine
 * Web Audio API: loading samples, real-time preview, seamless looping, WAV export.
 */

const AudioEngine = (() => {
  let ctx = null;
  let previewSources = [];
  let isPlaying = false;
  let loopBuffer = null;
  let loopSource = null;
  let masterGain = null;

  const CROSSFADE_DURATION = 3; // seconds
  const SAMPLE_RATE = 48000;

  function ensureContext() {
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      masterGain = ctx.createGain();
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /**
   * Load an audio file from a URL into an AudioBuffer.
   */
  async function loadSample(url) {
    const audioCtx = ensureContext();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch audio: ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();
    return audioCtx.decodeAudioData(arrayBuf);
  }

  /**
   * Preview a single sample (one-shot, stops any previous preview).
   */
  let previewOnEnded = null;

  /**
   * Preview a single sample (one-shot, stops any previous preview).
   * @param {AudioBuffer} buffer
   * @param {Function} [onEnded] - Called when playback finishes or is stopped
   */
  function previewSample(buffer, onEnded) {
    stopPreview();
    const audioCtx = ensureContext();
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(masterGain);
    src.start();
    previewSources.push(src);
    previewOnEnded = onEnded || null;
    src.onended = () => {
      previewSources = previewSources.filter(s => s !== src);
      if (previewOnEnded) { previewOnEnded(); previewOnEnded = null; }
    };
  }

  function stopPreview() {
    previewSources.forEach(s => { try { s.stop(); } catch(e) {} });
    previewSources = [];
    if (previewOnEnded) { previewOnEnded(); previewOnEnded = null; }
  }

  function isPreviewPlaying() {
    return previewSources.length > 0;
  }

  /**
   * Render a seamless loop from layers using OfflineAudioContext.
   * @param {Array<{buffer: AudioBuffer, volume: number, offset: number, loop: boolean}>} layers
   * @param {number} loopLength - Loop duration in seconds
   * @param {Function} onProgress - Progress callback (0-1)
   * @returns {Promise<AudioBuffer>} The rendered seamless loop
   */
  async function renderLoop(layers, loopLength, onProgress) {
    const renderLength = loopLength + CROSSFADE_DURATION;
    const totalFrames = Math.ceil(renderLength * SAMPLE_RATE);
    const offline = new OfflineAudioContext(2, totalFrames, SAMPLE_RATE);

    for (const layer of layers) {
      if (!layer.buffer || layer.muted) continue;

      const gain = offline.createGain();
      gain.gain.value = layer.volume;
      gain.connect(offline.destination);

      const trimStart = layer.trimStart || 0;
      const trimLength = layer.trimLength || layer.buffer.duration;
      const loopOffset = layer.loopOffset || 0;

      if (layer.loop) {
        // Looping: schedule trimmed segment repeatedly to fill render length
        let time = loopOffset;
        while (time < renderLength) {
          if (time + trimLength > 0) {
            const src = offline.createBufferSource();
            src.buffer = layer.buffer;
            src.connect(gain);
            if (time >= 0) {
              src.start(time, trimStart, trimLength);
            } else {
              // Start partway through the segment
              src.start(0, trimStart + (-time), trimLength + time);
            }
          }
          time += trimLength;
        }
      } else {
        // One-shot: play trimmed segment once at loopOffset
        const src = offline.createBufferSource();
        src.buffer = layer.buffer;
        src.connect(gain);
        src.start(Math.max(0, loopOffset), trimStart, trimLength);
      }
    }

    if (onProgress) onProgress(0.3);
    const rendered = await offline.startRendering();
    if (onProgress) onProgress(0.7);

    // Apply crossfade: mix the tail back into the start
    const result = applyLoopCrossfade(rendered, loopLength, CROSSFADE_DURATION);
    if (onProgress) onProgress(1.0);
    return result;
  }

  /**
   * Apply equal-power crossfade to create a seamless loop.
   * Takes a rendered buffer of (loopLength + crossfadeDuration) and folds the tail onto the start.
   */
  function applyLoopCrossfade(buffer, loopLength, crossfadeDuration) {
    const loopFrames = Math.floor(loopLength * buffer.sampleRate);
    const fadeFrames = Math.floor(crossfadeDuration * buffer.sampleRate);
    const channels = buffer.numberOfChannels;

    // Create the output context just for creating a buffer
    const audioCtx = ensureContext();
    const output = audioCtx.createBuffer(channels, loopFrames, buffer.sampleRate);

    for (let ch = 0; ch < channels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = output.getChannelData(ch);

      // Copy main body
      for (let i = 0; i < loopFrames; i++) {
        dst[i] = src[i];
      }

      // Crossfade: blend tail into start
      for (let i = 0; i < fadeFrames; i++) {
        const t = i / fadeFrames;
        // Equal-power crossfade
        const fadeOut = Math.cos(t * Math.PI * 0.5);
        const fadeIn = Math.sin(t * Math.PI * 0.5);
        const tailSample = src[loopFrames + i] || 0;
        dst[i] = dst[i] * fadeIn + tailSample * fadeOut;
      }
    }

    return output;
  }

  /**
   * Start looping playback of a rendered buffer.
   */
  let loopStartTime = 0;
  let loopDuration = 0;

  function playLoop(buffer) {
    stopLoop();
    const audioCtx = ensureContext();
    loopBuffer = buffer;
    loopSource = audioCtx.createBufferSource();
    loopSource.buffer = buffer;
    loopSource.loop = true;
    loopSource.connect(masterGain);
    loopSource.start();
    loopStartTime = audioCtx.currentTime;
    loopDuration = buffer.duration;
    isPlaying = true;
  }

  function stopLoop() {
    if (loopSource) {
      try { loopSource.stop(); } catch(e) {}
      loopSource = null;
    }
    isPlaying = false;
  }

  function getIsPlaying() {
    return isPlaying;
  }

  /** Returns 0-1 progress through the current loop iteration. */
  function getLoopProgress() {
    if (!isPlaying || !ctx || loopDuration === 0) return 0;
    const elapsed = ctx.currentTime - loopStartTime;
    return (elapsed % loopDuration) / loopDuration;
  }

  /** Returns current time in seconds within the loop. */
  function getLoopTime() {
    if (!isPlaying || !ctx || loopDuration === 0) return 0;
    const elapsed = ctx.currentTime - loopStartTime;
    return elapsed % loopDuration;
  }

  /** Seek to a specific time (in seconds) within the loop. */
  function seekLoop(time) {
    if (!loopBuffer || !ctx) return;
    const wasPlaying = isPlaying;
    if (loopSource) {
      try { loopSource.stop(); } catch(e) {}
    }
    loopSource = ctx.createBufferSource();
    loopSource.buffer = loopBuffer;
    loopSource.loop = true;
    loopSource.connect(masterGain);
    loopSource.start(0, time);
    loopStartTime = ctx.currentTime - time;
    isPlaying = true;
  }

  /**
   * Encode an AudioBuffer as a WAV file and trigger download.
   */
  function exportWav(buffer, filename = 'soundscape-loop.wav') {
    const wavData = encodeWav(buffer);
    const blob = new Blob([wavData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /**
   * Encode AudioBuffer to WAV (16-bit PCM).
   */
  function encodeWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const numFrames = buffer.length;
    const dataSize = numFrames * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const arrayBuf = new ArrayBuffer(totalSize);
    const view = new DataView(arrayBuf);

    // WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Interleave channels and convert float32 to int16
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }

    let offset = headerSize;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channels[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample * 0x7FFF, true);
        offset += bytesPerSample;
      }
    }

    return arrayBuf;
  }

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  return {
    loadSample,
    previewSample,
    stopPreview,
    isPreviewPlaying,
    renderLoop,
    playLoop,
    stopLoop,
    getIsPlaying,
    exportWav,
    ensureContext,
    getLoopProgress,
    getLoopTime,
    seekLoop,
  };
})();
