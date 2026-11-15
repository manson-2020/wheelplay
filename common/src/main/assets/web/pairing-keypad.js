// Six visible PIN fields plus a head-unit-friendly on-screen keypad. Extracted from the
// monolithic app.js during the main -> tesla merge; see docs/URL_FLAGS.md for the module split.
// Six visible digits share one canonical value for the existing pairing API.
export function createPairingCodeInput(inputs, value, { onChange = () => {}, onFocus = () => {}, onDismiss = () => {} } = {}) {
  let active = 0, enabled = true;
  const numbers = text => String(text || '').replace(/[^0-9]/g, '');
  const complete = () => inputs.every(input => /^[0-9]$/.test(input.value));
  const sync = () => { value.value = inputs.map(input => input.value).join(''); onChange(!enabled || complete()); };
  const focus = index => { active = index; inputs[index].focus({ preventScroll: true }); inputs[index].select?.(); };
  function fill(text, index = 0, advance = false) {
    const digits = numbers(text).slice(0, 6);
    if (digits.length === 6) index = 0;
    for (let offset = 0; offset < digits.length && index + offset < inputs.length; offset++) {
      inputs[index + offset].value = digits[offset];
    }
    sync();
    if (advance && digits.length) focus(Math.min(5, index + digits.length));
  }
  function digit(text) { if (enabled && /^[0-9]$/.test(text)) fill(text, active, true); }
  function backspace() {
    if (!enabled) return;
    if (!inputs[active].value && active > 0) active--;
    inputs[active].value = ''; sync(); focus(active);
  }
  inputs.forEach((input, index) => {
    input.addEventListener('focus', () => { active = index; input.select?.(); onFocus(index); });
    input.addEventListener('click', () => onFocus(index));
    input.addEventListener('input', () => {
      const text = numbers(input.value);
      input.value = '';
      fill(text, index, true);
    });
    input.addEventListener('paste', event => {
      const text = numbers(event.clipboardData?.getData('text'));
      event.preventDefault();
      if (text) fill(text, index, true);
    });
    input.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      active = index;
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); digit(event.key); return; }
      if (event.key === 'Backspace') { event.preventDefault(); backspace(); return; }
      if (event.key === 'Delete') { event.preventDefault(); input.value = ''; sync(); return; }
      if (event.key === 'Escape') { event.preventDefault(); onDismiss(); return; }
      let next = index;
      if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
      else if (event.key === 'ArrowRight') next = Math.min(5, index + 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 5;
      else return;
      event.preventDefault(); focus(next);
    });
  });
  const set = text => { inputs.forEach(input => { input.value = ''; }); fill(text); };
  set(value.value);
  return { set, digit, backspace, clear() { if (enabled) { set(''); focus(0); } },
    focus() { focus(Math.max(0, inputs.findIndex(input => !/^[0-9]$/.test(input.value)))); },
    get activeIndex() { return active; }, get complete() { return complete(); }, enabled(value) {
    enabled = value;
    inputs.forEach(input => { input.disabled = !enabled; input.required = enabled; });
    sync();
  } };
}

// Positions are in visual-viewport CSS coordinates, including pinch-zoom offsets.
export function placePairingKeypad(anchor, viewport, size) {
  const margin = 12, gap = 8;
  const left = viewport.left + margin, top = viewport.top + margin;
  const right = viewport.left + viewport.width - margin, bottom = viewport.top + viewport.height - margin;
  if (size.width > right - left || size.height > bottom - top || anchor.top < top || anchor.bottom > bottom) return null;
  const x = Math.max(left, Math.min(anchor.left, right - size.width));
  const y = Math.max(top, Math.min(anchor.top, bottom - size.height));
  if (anchor.bottom + gap + size.height <= bottom) return { left: x, top: anchor.bottom + gap, placement: 'below' };
  if (anchor.top - gap - size.height >= top) return { left: x, top: anchor.top - gap - size.height, placement: 'above' };
  if (anchor.right + gap + size.width <= right) return { left: anchor.right + gap, top: y, placement: 'right' };
  if (anchor.left - gap - size.width >= left) return { left: anchor.left - gap - size.width, top: y, placement: 'left' };
  return null;
}
