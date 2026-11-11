// The phone status gauge: the circular badge the browser floats over the head-unit picture, showing
// this Android phone's battery, media volume and the transport carrying the stream. Geometry, markup
// and in-place updates live here so `app.js` only wires the badge into the page.
//
// The status bar inside the picture belongs to the iPhone, so the server also reports this Android
// phone: battery, media volume and the radio carrying the stream. One circular mark, flat strokes and
// no gradients: the battery is a solid arc and the volume a meter of ticks, so the two readings differ
// by silhouette alone. Dark frosted glass with light strokes, because the gauge floats over a night map
// far more often than over a daylight route, and a mid-grey track is the only way the empty part of
// either stays readable on both. Numbers for the two readings, a language-free icon for the transport,
// so nothing needs a translation.
const phoneNetworks = ['wifi', '5g', '4g', '3g', '2g', 'cellular', 'eth', 'none'];
// Matches PhoneStatus.LOW_BATTERY_PERCENT: at or above this the reading is healthy, below it the
// driver-facing red warning takes over - unless the phone is on the charger.
const lowBatteryPercent = 20;
// Light strokes on dark glass, but held back from pure white: #f2f5f7 measured 17.5:1 against a night
// map, which stings, while it was only 5.7:1 over a bright route. The track sits at 1.9:1 even where
// the glass picks up a white strip, so an unfilled ring never reads as "no volume". Only the battery
// ring leaves that ink: green while the phone charges, red under the threshold.
const badgeInk = '#dfe4e8', badgeTrack = '#8b95a1', badgeLow = '#ff453a', badgeCharging = '#30d158';
const ringRadius = 44, ringStroke = 9, markScale = 0.86;
// The glyph's own ink centre sits above the band between the two numbers, so it is nudged down to land
// in the middle of that band instead of the middle of the circle.
const markShift = 1.8;
// The rings part at the top for the battery number and at the bottom for the volume number, so the two
// readings sit on one axis. Clockwise from the top the disc then reads battery number, battery arc,
// volume number, volume meter - each fills clockwise from the opening its own number sits in.
const ringGap = 26, ringEnd = 180 - ringGap;
// The volume is a level meter, not a second progress arc: eight rounded ticks, thinner than the
// battery stroke, so the two readings differ in silhouette instead of needing a colour of their own.
// A round cap reaches half a stroke past its arc, so the slot has to give up that much at each end.
const tickCount = 8, tickStroke = 6.5, tickGap = 10.5, tickSlot = (ringEnd - ringGap) / tickCount;
// The meter's outermost tick stops 5.25 degrees inside the opening and its round cap is only 4.2 wide,
// so the volume run ends 27.0 degrees from the opening while the battery arc's fatter cap reached 20.1 -
// the left side read as shorter. Insetting the battery arc by that difference aligns both ends.
const batteryInset = 6.9;

const counted = (value, limit) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(limit, Math.round(number)) : null;
};

// Angles run clockwise from 12 o'clock. A path always starts where its number sits, so the dash offset
// grows clockwise: the battery from the top opening down the right, the volume from the bottom
// opening up the left.
const ringPoint = (degrees, radius = ringRadius) => [
  50 + radius * Math.sin(degrees * Math.PI / 180),
  50 - radius * Math.cos(degrees * Math.PI / 180),
];

function ringPath(from, to, radius = ringRadius) {
  const [x0, y0] = ringPoint(from, radius), [x1, y1] = ringPoint(to, radius);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${radius} ${radius} 0 0 1` +
    ` ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

const batteryArc = ringPath(ringGap + batteryInset, ringEnd - batteryInset);

// Every tick owns one slot of the volume side with half a gap at each end, so neighbours never touch.
function tickPath(index) {
  const from = 180 + ringGap + index * tickSlot + tickGap / 2;
  return ringPath(from, from + tickSlot - tickGap);
}

const volumeTicks = Array.from({ length: tickCount }, (_, index) => tickPath(index));

/**
 * Progress is a dash offset over a fixed track rather than a re-cut path: `pathLength` normalises the
 * arc to 100 units, so a new reading is one number CSS can interpolate instead of a rebuilt shape.
 * A value that is merely small still leaves a stub, so it never reads as a missing stroke.
 */
// An empty ring has to read as empty. At an offset of exactly one path length the round cap of the
// dash sits on the arc's start and paints a dot back into the opening, and a gap the size of the dash
// wraps the pattern onto the far end - both look like a sliver of progress in the wrong direction. So
// the empty state stops a cap radius past 100, and the gap is long enough that the tail never returns.
const ringEmpty = 107, ringDashArray = '100 300';
const ringDash = percent =>
  percent === null || percent <= 0 ? ringEmpty : 100 - Math.max(6, percent);
// The same offset trick per tick, without the stub: a tick the level has not reached yet is simply
// empty, and the tick holding the level is filled part of the way. Whole numbers keep the markup clean.
const tickDash = (percent, index) => {
  if (percent === null) return 100;
  const share = Math.max(0, Math.min(1, percent * tickCount / 100 - index));
  return 100 - Math.round(share * 100);
};

// Both marks share one box, so switching networks never changes the icon's size. Every slot carries the
// strength that lights it: the Wi-Fi fans fill from the inside out, the cellular bars from the left.
// The wired mark copies the platform's USB tethering glyph - two chevrons framing three dots - and
// lights as one piece, because a cable has no strength to meter.
const markSlots = {
  wifi: [
    { tag: 'path', attrs: 'd="M43.2 53.3A11 11 0 0 1 56.8 53.3"', at: 1, ink: 'stroke' },
    { tag: 'path', attrs: 'd="M38.3 47A19 19 0 0 1 61.7 47"', at: 2, ink: 'stroke' },
    { tag: 'path', attrs: 'd="M33.4 40.7A27 27 0 0 1 66.6 40.7"', at: 3, ink: 'stroke' },
    { tag: 'circle', attrs: 'cx="50" cy="62" r="2.5" stroke="none"', at: 1, ink: 'fill' },
  ],
  eth: [
    { tag: 'path', attrs: 'd="M37 39.5 30.5 50 37 60.5"', at: 1, ink: 'stroke' },
    { tag: 'path', attrs: 'd="M63 39.5 69.5 50 63 60.5"', at: 1, ink: 'stroke' },
    { tag: 'circle', attrs: 'cx="42.5" cy="50" r="3" stroke="none"', at: 1, ink: 'fill' },
    { tag: 'circle', attrs: 'cx="50" cy="50" r="3" stroke="none"', at: 1, ink: 'fill' },
    { tag: 'circle', attrs: 'cx="57.5" cy="50" r="3" stroke="none"', at: 1, ink: 'fill' },
  ],
  cellular: [8, 16, 24, 32].map((height, index) => ({
    tag: 'rect',
    attrs: `x="${(31.25 + index * 10.37).toFixed(1)}" y="${64 - height}" width="6.4" height="${height}" rx="2.8"`,
    at: index + 1,
    ink: 'fill',
  })),
};

const markKind = network => (network === 'wifi' ? 'wifi' : network === 'eth' ? 'eth' : 'cellular');
// The Wi-Fi fan and the wired chevrons are stroked glyphs; the cellular bars fill their own shapes.
const markStrokeWidth = kind => (kind === 'cellular' ? 0 : 5);

const slotMarkup = (slot, bars) =>
  `<${slot.tag} ${slot.attrs} data-at="${slot.at}" data-ink="${slot.ink}"` +
  ` ${slot.ink}="${slot.at <= bars ? badgeInk : badgeTrack}"/>`;

/** Battery, volume, network and colour for one frame, or null when the server reported nothing. */
export function phoneGaugeValues(phone) {
  if (!phone || typeof phone !== 'object') return null;
  const network = phoneNetworks.includes(phone.network) ? phone.network : 'none';
  const battery = counted(phone.battery, 100);
  const volume = counted(phone.volume, 100);
  const bars = counted(phone.bars, 4) ?? 0;
  if (battery === null && volume === null && network === 'none') return null;
  // The number inherits the battery arc colour: green only while the phone charges, red under the
  // threshold; a healthy reading keeps the same ink as the volume ring.
  const batteryColor = phone.charging === true ? badgeCharging :
    battery !== null && battery < lowBatteryPercent ? badgeLow : badgeInk;
  return { network, battery, volume, bars, batteryColor };
}

// Two bare numbers on one axis cannot be told apart - worst of all the volume, because the battery arc
// ends right beside it. So each number gets a short arc on its outer side instead of a full ring:
// solid above the battery, dashed below the volume. The disc has shrunk twice (88 to 56 to 44 px) and
// the ring, ticks and mark scale down with it, but the readings do not: the font is sized so the digits
// keep the height they rendered at on the 56 px disc - a shrink spends the ring's slack, not the digits'.
const numberFont = 18, collarRadius = 47, collarStroke = 2.6, collarDegrees = 20;
// The numbers sit a step further in than the collar's edge on purpose: at 2.5 units the digits read as
// pressed against the arc, at 3.8 they read as a reading under it.
const batteryBaseline = 21.1, volumeBaseline = 91.8;
// With both runs ending on the same angle the collar can sit on the disc's axis and still leave the
// same gap either side.
const collarCentre = 0;
// Butt caps and a gap wider than the dash: the dashes have to read as dashes next to a solid one.
const collarDash = '2.6 2.81';
const batteryCollar = ringPath(collarCentre - collarDegrees, collarCentre + collarDegrees, collarRadius);
const volumeCollar = ringPath(
  180 - collarCentre - collarDegrees, 180 - collarCentre + collarDegrees, collarRadius,
);

/** A reading: its number, with a matching arc on the side away from the disc's middle. */
const reading = (value, className, color, baseline, collar, dashed) => {
  const text = value === null ? '' : String(value);
  if (text === '') return '';
  return `<path class="${dashed ? 'volume-collar' : 'battery-collar'}" d="${collar}" fill="none"` +
    ` stroke="${color}" stroke-width="${collarStroke}" stroke-linecap="${dashed ? 'butt' : 'round'}"` +
    (dashed ? ` stroke-dasharray="${collarDash}"` : '') + '/>' +
    `<text class="${className}" x="50" y="${baseline}" text-anchor="middle" fill="${color}"` +
    ` font-size="${numberFont}" font-weight="600">${text}</text>`;
};

/** The gauge skeleton. Only the parts that never animate are fixed here; values arrive as styles. */
export function phoneStatusMarkup(values) {
  const { network, battery, volume, bars, batteryColor } = values;
  const tickTrack = index =>
    `<path class="volume-tick" d="${volumeTicks[index]}" stroke="${badgeTrack}"/>`;
  const tickLevel = index =>
    `<path class="volume-level" d="${volumeTicks[index]}" pathLength="100"` +
    ` stroke-dasharray="${ringDashArray}" stroke-dashoffset="${tickDash(volume, index)}"` +
    ` stroke="${badgeInk}"/>`;
  return '<svg viewBox="0 0 100 100" width="100%" height="100%" role="presentation">' +
    `<g class="rings" fill="none" stroke-width="${ringStroke}" stroke-linecap="round">` +
    `<path class="battery-track" d="${batteryArc}" stroke="${badgeTrack}"/>` +
    `<path class="battery-level" d="${batteryArc}" pathLength="100" stroke-dasharray="${ringDashArray}"` +
    ` stroke-dashoffset="${ringDash(battery)}" stroke="${batteryColor}"/>` + '</g>' +
    `<g class="ticks" fill="none" stroke-width="${tickStroke}" stroke-linecap="round">` +
    volumeTicks.map((_, index) => tickTrack(index)).join('') +
    volumeTicks.map((_, index) => tickLevel(index)).join('') + '</g>' +
    `<g class="mark" data-network="${network}" transform="translate(0 ${markShift}) translate(50 50) scale(${markScale}) translate(-50 -50)"` +
    ` fill="none" stroke-width="${markStrokeWidth(markKind(network))}" stroke-linecap="round">` +
    markSlots[markKind(network)].map(slot => slotMarkup(slot, bars)).join('') + '</g>' +
    reading(battery, 'battery-number', batteryColor, batteryBaseline, batteryCollar, false) +
    reading(volume, 'volume-number', badgeInk, volumeBaseline, volumeCollar, true) + '</svg>';
}

/**
 * Updates a rendered gauge in place. Writing styles instead of rebuilding markup is what lets the
 * rings sweep, the colours cross-fade and the signal slots light one by one.
 */
export function applyPhoneGauge(svg, values) {
  const { network, battery, volume, bars, batteryColor } = values;
  if (!svg) return false;
  const batteryLevel = svg.querySelector('.battery-level');
  const volumeTicksInDom = svg.querySelectorAll('.volume-level');
  if (!batteryLevel || volumeTicksInDom.length !== tickCount) return false;
  batteryLevel.style.strokeDashoffset = String(ringDash(battery));
  batteryLevel.style.stroke = batteryColor;
  // Every tick carries its own offset, so the level crosses a tick boundary one tick at a time.
  volumeTicksInDom.forEach((tick, index) => {
    tick.style.strokeDashoffset = String(tickDash(volume, index));
  });
  const number = svg.querySelector('.battery-number');
  if (number) {
    number.textContent = battery === null ? '' : String(battery);
    number.style.fill = batteryColor;
  }
  // The collar belongs to the reading, so it follows the battery through red, green and ink.
  const collar = svg.querySelector('.battery-collar');
  if (collar) collar.style.stroke = batteryColor;
  const volumeNumber = svg.querySelector('.volume-number');
  if (volumeNumber) volumeNumber.textContent = volume === null ? '' : String(volume);
  const mark = svg.querySelector('.mark');
  if (mark) {
    if (mark.dataset.network !== network) {
      const kind = markKind(network);
      mark.dataset.network = network;
      mark.setAttribute('stroke-width', markStrokeWidth(kind));
      mark.innerHTML = markSlots[kind].map(slot => slotMarkup(slot, bars)).join('');
    }
    for (const slot of mark.querySelectorAll('[data-at]')) {
      slot.style[slot.dataset.ink] = Number(slot.dataset.at) <= bars ? badgeInk : badgeTrack;
    }
  }
  return true;
}

/** Markup for the floating badge, or null when the server reported nothing usable. */
export function phoneStatusBadge(phone) {
  const values = phoneGaugeValues(phone);
  return values === null ? null : phoneStatusMarkup(values);
}
