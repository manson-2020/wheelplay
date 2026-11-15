// Browser-local frame measurements used by the diagnostic overlay.
// Browser-local measurements: committed images per rolling second and receive-to-decode time.
export function createImageDebugStats(now = () => performance.now()) {
  let started = now(), frames = [], decodeMs = null, totalFrames = 0;
  return {
    reset() { started = now(); frames = []; decodeMs = null; totalFrames = 0; },
    frame(receivedAt) {
      const at = now(); frames.push(at); totalFrames++;
      if (frames.length > 240) frames.shift();
      decodeMs = Number.isFinite(receivedAt) ? Math.max(0, at - receivedAt) : null;
    },
    sample() {
      const at = now(); frames = frames.filter(frame => frame > at - 1000);
      return { fps: at - started >= 1000 ? frames.length : null, decodeMs, totalFrames };
    },
  };
}
