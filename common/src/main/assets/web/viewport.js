// A surface inversely scaled inside the visual viewport cancels browser zoom.
// Its bounding rectangle remains in the same CSS coordinates as pointer events.
export function unzoomedDisplayRect(rect, visual) {
  if (!visual || !Number.isFinite(visual.scale) || visual.scale <= 0 || visual.width <= 0 || visual.height <= 0) return null;
  const left = visual.offsetLeft || 0, offsetTop = visual.offsetTop || 0;
  const top = Math.max(offsetTop, rect.top || 0);
  return { left, top, width: visual.width, height: Math.max(0, offsetTop + visual.height - top), scale: visual.scale };
}

// Match WebSession's viewport bounds. A small visible area can still display a
// larger negotiated canvas; scale both axes together instead of stretching it.
export function browserViewportSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  if (ratio < 0.5 || ratio > 4) return null;
  const scale = Math.min(8192 / Math.max(width, height), Math.max(1, 320 / Math.min(width, height)));
  const even = value => Math.round(value / 2) * 2;
  const h = even(height * scale);
  // Even-pixel rounding must not push an otherwise valid ratio outside bounds.
  const w = Math.max(Math.ceil(h / 4) * 2, Math.min(h * 4, even(width * scale)));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || h < 320 || w > 8192 || h > 8192) return null;
  return { width: w, height: h };
}

// Coordinates are normalized in the visible video rectangle, excluding letterboxing.
export function mapPoint(clientX, clientY, rect, width, height, clamp = false) {
  if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const w = width * scale, h = height * scale;
  const x = (clientX - rect.left - (rect.width - w) / 2) / w;
  const y = (clientY - rect.top - (rect.height - h) / 2) / h;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

export function pairingCodeFromUrl(search) {
  const match = String(search || '').match(/(?:^|[?&])code=([^&]*)/);
  let code = '';
  try { code = match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : ''; } catch (_) { return null; }
  return /^[0-9]{6}$/.test(code) ? code : null;
}

