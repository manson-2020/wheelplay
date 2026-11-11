// V3 appends the negotiated image format to the v2 header. PCM has a different magic.
export function decodeVideoPacket(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return null;
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true), protocol = magic === 0x33565057 ? 3 : magic === 0x32565057 ? 2 : null;
  if (!protocol) return null;
  const headerBytes = protocol === 3 ? 40 : 36;
  if (buffer.byteLength <= headerBytes) throw new Error('Truncated video packet');
  const packet = { sessionId: view.getFloat64(4, true), videoEpoch: view.getFloat64(12, true),
    sequence: view.getFloat64(20, true), width: view.getUint32(28, true), height: view.getUint32(32, true) };
  if (![packet.sessionId, packet.videoEpoch, packet.sequence].every(value => Number.isSafeInteger(value) && value >= 0) ||
      packet.width < 1 || packet.height < 1) throw new Error('Invalid video packet');
  const format = protocol === 3 ? view.getUint32(36, true) : 1;
  if (![1, 2].includes(format)) throw new Error('Invalid image format');
  return { ...packet, protocol, mime: format === 2 ? 'image/webp' : 'image/jpeg', jpeg: buffer.slice(headerBytes) };
}

export function probeWebp({ createImage = () => new Image(), schedule = setTimeout, cancel = clearTimeout,
  createUrl = data => URL.createObjectURL(data), revokeUrl = url => URL.revokeObjectURL(url),
} = {}) {
  return new Promise(resolve => {
    let image, url = null, timer = null, finished = false;
    const finish = supported => {
      if (finished) return; finished = true; cancel(timer);
      if (image) { image.onload = image.onerror = null; image.removeAttribute('src'); }
      if (url !== null) revokeUrl(url);
      resolve(supported);
    };
    try {
      image = createImage(); timer = schedule(() => finish(false), 1500);
      image.onload = () => finish(image.naturalWidth === 2 && image.naturalHeight === 2);
      image.onerror = () => finish(false);
      // The Android page allows blob: images but deliberately blocks data: URLs.
      // This is the same 2x2 WebP fixture used by the capability probe.
      url = createUrl(new Blob([new Uint8Array([
        82, 73, 70, 70, 60, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 48, 0, 0, 0,
        208, 1, 0, 157, 1, 42, 2, 0, 2, 0, 2, 0, 52, 37, 160, 2, 116, 186, 1, 248,
        0, 3, 176, 0, 254, 240, 196, 11, 255, 32, 185, 97, 117, 200, 215, 255, 32,
        63, 228, 7, 252, 128, 255, 248, 242, 0, 0, 0,
      ])], { type: 'image/webp' }));
      image.src = url;
    } catch (_) { finish(false); }
  });
}

// HEVC support belongs to the browser build, not to the stream, and a head unit has no console:
// probe it once so `?diag=1` can report `hevc=1/0` next to the H.264-only codec stream. Three
// strings, because a decoder may take the hvc1 sample entry but not hev1 - or only the lower level;
// the first that answers true is the one a codec stream could later be configured with. Resolves to
// that string, or null when HEVC is unreachable here.
export const HEVC_CODEC_STRINGS = ['hvc1.1.6.L93.B0', 'hvc1.1.6.L123.B0', 'hev1.1.6.L93.B0'];
export function probeHevc({ decoder = typeof VideoDecoder === 'undefined' ? null : VideoDecoder,
  candidates = HEVC_CODEC_STRINGS } = {}) {
  if (!decoder || typeof decoder.isConfigSupported !== 'function') return Promise.resolve(null);
  const attempt = index => {
    if (index >= candidates.length) return null;
    const codec = candidates[index];
    let request;
    // A malformed string throws instead of rejecting, so the fallback covers both.
    try { request = decoder.isConfigSupported({ codec, optimizeForLatency: true }); }
    catch (_) { return null; }
    return Promise.resolve(request)
      .then(result => result?.supported === true ? codec : attempt(index + 1))
      .catch(() => attempt(index + 1));
  };
  return Promise.resolve(attempt(0));
}

