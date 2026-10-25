import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneStatusBadge, phoneGaugeValues } from '../common/src/main/assets/web/app.js';

const ink = '#dfe4e8', track = '#8b95a1', low = '#ff453a', charging = '#30d158';

// The battery ring holds its strokes in a fixed order: track then progress. Progress is a dash offset
// over a `pathLength` of 100, so the offset is the value, and an empty ring parks that offset past 100
// so no cap of the hidden dash can show. The volume side is a meter of eight ticks, each carrying its
// own offset in the same units.
const groupMarkup = (markup, cls) =>
  markup.match(new RegExp(`<g class="${cls}"[\\s\\S]*?<\\/g>`))?.[0] ?? '';
const ringStrokes = markup => [...groupMarkup(markup, 'rings')
  .matchAll(/stroke="(#[0-9a-f]{6})"/g)].map(match => match[1]);
const ringOffsets = markup => [...groupMarkup(markup, 'rings')
  .matchAll(/class="(battery|volume)-level"[^>]*stroke-dashoffset="([\d.]+)"/g)]
  .reduce((all, match) => ({ ...all, [match[1]]: Number(match[2]) }), {});
const tickPaths = markup => [...markup.matchAll(/class="volume-tick" d="([^"]+)"/g)]
  .map(match => match[1]);
const tickStrokes = markup => [...groupMarkup(markup, 'ticks')
  .matchAll(/stroke="(#[0-9a-f]{6})"/g)].map(match => match[1]);
const tickOffsets = markup => [...groupMarkup(markup, 'ticks')
  .matchAll(/class="volume-level"[^>]*stroke-dashoffset="([\d.]+)"/g)].map(match => Number(match[1]));
const markSlots = markup => [...groupMarkup(markup, 'mark')
  .matchAll(/data-at="(\d)" data-ink="(stroke|fill)" (?:stroke|fill)="(#[0-9a-f]{6})"/g)]
  .map(match => ({ at: Number(match[1]), ink: match[2], color: match[3] }));
const markNetwork = markup => markup.match(/class="mark" data-network="([^"]+)"/)?.[1];
const numberFill = markup => markup.match(/class="battery-number"[^>]*fill="(#[0-9a-f]{6})"/)?.[1];
const numberText = markup => markup.match(/class="battery-number"[^>]*>([^<]*)</)?.[1];
const volumeText = markup => markup.match(/class="volume-number"[^>]*>([^<]*)</)?.[1];
const tagOf = (markup, cls) => markup.match(new RegExp(`<[a-z]+ class="${cls}"[^>]*/>`))?.[0] ?? '';
const ringPath = (markup, name) => markup.match(new RegExp(`class="${name}-level" d="([^"]+)"`))?.[1];
const gauge = phone => phoneStatusBadge(phone);

test('the gauge stays hidden until the server reports the phone', () => {
  assert.equal(gauge(undefined), null);
  assert.equal(gauge(null), null);
  // Nothing readable at all: an empty circle must not float over the picture.
  assert.equal(gauge({ network: 'none', battery: -1, volume: -1 }), null);
});

test('the battery number copies the colour of the battery arc exactly', () => {
  assert.equal(numberFill(gauge({ network: 'wifi', bars: 3, battery: 88, volume: 64 })), ink);
  assert.equal(numberFill(gauge({ network: 'wifi', bars: 3, battery: 14, volume: 64 })), low);
  assert.equal(numberFill(gauge({ network: 'wifi', bars: 3, battery: 63, volume: 64, charging: true })), charging);
  assert.equal(ringStrokes(gauge({ network: 'wifi', bars: 3, battery: 14, volume: 64 }))[1], low);
});

test('the battery keeps the ink when healthy, turns red under the threshold, green while charging', () => {
  const arc = markup => ringStrokes(markup)[1];
  // Healthy and off the charger: the same ink the volume ring uses, so the battery is not "special".
  assert.equal(arc(gauge({ network: 'wifi', bars: 2, battery: 21, volume: 40 })), ink);
  // The threshold itself is still healthy; only below it does the warning take over.
  assert.equal(arc(gauge({ network: 'wifi', bars: 2, battery: 20, volume: 40 })), ink);
  assert.equal(arc(gauge({ network: 'wifi', bars: 2, battery: 19, volume: 40 })), low);
  // Green only while the phone charges, at both ends of the scale.
  assert.equal(arc(gauge({ network: 'wifi', bars: 2, battery: 15, volume: 40, charging: true })), charging);
  assert.equal(arc(gauge({ network: 'wifi', bars: 2, battery: 88, volume: 40, charging: true })), charging);
  assert.equal(numberFill(gauge({ network: 'wifi', bars: 2, battery: 88, volume: 40, charging: true })), charging);
  // Charging is told by the colour alone: no bolt, and the number stays in the top opening.
  const markup = gauge({ network: 'wifi', bars: 2, battery: 15, volume: 40, charging: true });
  assert.doesNotMatch(markup, /battery-charging/);
  assert.match(markup, /class="battery-number" x="50" y="18\.7"/);
});

test('each number carries its own short arc: solid above, dashed below', () => {
  const markup = gauge({ network: 'wifi', bars: 3, battery: 84, volume: 20 });
  // The collars repeat the grammar of the two long arcs and take the number's own colour, while the
  // side facing the middle stays open - a number boxed in a full ring read as a stamp, not a reading.
  assert.match(tagOf(markup, 'battery-collar'),
    /d="M34\.1 6\.3A46\.5 46\.5 0 0 1 65\.9 6\.3"[^>]*stroke="#dfe4e8" stroke-width="2\.6" stroke-linecap="round"/);
  assert.doesNotMatch(tagOf(markup, 'battery-collar'), /dasharray/);
  assert.match(tagOf(markup, 'volume-collar'),
    /d="M65\.9 93\.7A46\.5 46\.5 0 0 1 34\.1 93\.7"[^>]*stroke-dasharray="2\.6 2\.81"/);
  // Butt ends and a gap wider than the dash: the dashed collar must not read as a solid one.
  assert.match(tagOf(markup, 'volume-collar'), /stroke-linecap="butt"/);
  assert.match(markup, /class="battery-number" x="50" y="18\.7"/);
  assert.match(markup, /class="volume-number" x="50" y="91\.3"/);
  assert.match(markup, /font-size="14"/);
  // The collar never spans the opening's caps: thirty four degrees against their fifty two.
  assert.match(gauge({ network: 'wifi', bars: 3, battery: 100, volume: 100 }),
    /class="battery-number" x="50" y="18\.7"/);
  // The collar is part of the reading, so it changes colour with it and the volume keeps the ink.
  const charging = gauge({ network: 'wifi', bars: 3, battery: 84, volume: 20, charging: true });
  assert.match(charging, /class="battery-collar"[^>]*stroke="#30d158"/);
  assert.match(charging, /class="battery-number"[^>]*fill="#30d158"/);
  assert.match(charging, /class="volume-collar"[^>]*stroke="#dfe4e8"/);
});

test('the battery arc starts at the top opening and the numbers sit on one axis', () => {
  const markup = gauge({ network: 'wifi', bars: 3, battery: 62, volume: 40 });
  // The battery runs clockwise from the opening its number sits in, down the right side.
  // Inset so the run ends where the tick meter does: both sides stop 27 degrees from the openings.
  assert.equal(ringPath(markup, 'battery'), 'M73.9 13.1A44 44 0 0 1 73.9 86.9');
  // The volume number takes the bottom opening the transport word used to fill.
  assert.equal(volumeText(markup), '40');
  assert.doesNotMatch(markup, /mark-label/);
});

test('the volume is a meter of eight ticks, not a second arc', () => {
  const markup = gauge({ network: 'wifi', bars: 3, battery: 62, volume: 40 });
  const ticks = tickPaths(markup);
  assert.equal(ticks.length, 8);
  // The first tick leaves the bottom opening clockwise and runs up the left; the last stops short of
  // the top opening, so the meter never touches either number.
  assert.equal(ticks[0], 'M27.2 87.6A44 44 0 0 1 23.7 85.3');
  assert.equal(ticks[7], 'M23.7 14.7A44 44 0 0 1 27.2 12.4');
  // Thinner rounded bars, so the silhouette differs from the battery arc without a second colour.
  assert.match(groupMarkup(markup, 'ticks'), /stroke-width="6.5"/);
  assert.match(groupMarkup(markup, 'ticks'), /stroke-linecap="round"/);
  assert.match(groupMarkup(markup, 'rings'), /stroke-width="9"/);
  assert.deepEqual(tickStrokes(markup), [...Array(8).fill(track), ...Array(8).fill(ink)]);
  // 40% of eight ticks is three lit ticks and two fifths of the fourth.
  assert.deepEqual(tickOffsets(markup), [0, 0, 0, 80, 100, 100, 100, 100]);
});

test('each reading carries its own progress as a dash offset', () => {
  const markup = gauge({ network: 'wifi', bars: 4, battery: 88, volume: 64 });
  assert.deepEqual(ringStrokes(markup), [track, ink]);
  assert.deepEqual(ringOffsets(markup), { battery: 12 });
  // 64% of eight ticks is five lit ticks and the sixth filled 12% of the way.
  assert.deepEqual(tickOffsets(markup), [0, 0, 0, 0, 0, 88, 100, 100]);
  // Full and empty are the two ends the driver checks first, and both keep their track visible.
  assert.deepEqual(ringOffsets(gauge({ network: 'wifi', bars: 4, battery: 100, volume: 100 })),
    { battery: 0 });
  assert.deepEqual(tickOffsets(gauge({ network: 'wifi', bars: 4, battery: 100, volume: 100 })),
    [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ringOffsets(gauge({ network: 'wifi', bars: 4, battery: 0, volume: 0 })),
    { battery: 107 });
  assert.deepEqual(tickOffsets(gauge({ network: 'wifi', bars: 4, battery: 0, volume: 0 })),
    [100, 100, 100, 100, 100, 100, 100, 100]);
  // A reading too small to see still leaves a stub in the battery ring rather than vanishing.
  assert.deepEqual(ringOffsets(gauge({ network: 'wifi', bars: 4, battery: 3, volume: -1 })),
    { battery: 94 });
  assert.deepEqual(tickOffsets(gauge({ network: 'wifi', bars: 4, battery: 3, volume: -1 })),
    [100, 100, 100, 100, 100, 100, 100, 100]);
});

test('an empty ring stays empty at both of its ends', () => {
  const markup = gauge({ network: 'wifi', bars: 4, battery: 0, volume: 0 });
  // A gap the size of the dash wraps the pattern onto the far end of the arc, so the tail lights up
  // even at zero; the gap is therefore three times the dash.
  assert.deepEqual([...groupMarkup(markup, 'rings').matchAll(/stroke-dasharray="([^"]+)"/g)]
    .map(match => match[1]), ['100 300']);
  // One path length would park the round cap on the arc's start, so empty sits further out.
  assert.equal(ringOffsets(markup).battery, 107);
  // A tick has no cap to park, so an unlit one stops at exactly one path length and draws nothing.
  assert.deepEqual(tickOffsets(markup), [100, 100, 100, 100, 100, 100, 100, 100]);
});

test('the Wi-Fi fan is the signal meter: its arcs light from the inside out', () => {
  const fans = phone => markSlots(gauge(phone)).filter(slot => slot.ink === 'stroke').map(slot => slot.color);
  assert.deepEqual(fans({ network: 'wifi', bars: 4, battery: 88, volume: 64 }), [ink, ink, ink]);
  assert.deepEqual(fans({ network: 'wifi', bars: 3, battery: 88, volume: 64 }), [ink, ink, ink]);
  assert.deepEqual(fans({ network: 'wifi', bars: 2, battery: 88, volume: 64 }), [ink, ink, track]);
  assert.deepEqual(fans({ network: 'wifi', bars: 1, battery: 88, volume: 64 }), [ink, track, track]);
  // No signal at all: the fans and their dot fall back to the track colour, they never disappear.
  const dead = gauge({ network: 'wifi', bars: 0, battery: 88, volume: 64 });
  assert.deepEqual(fans({ network: 'wifi', bars: 0, battery: 88, volume: 64 }), [track, track, track]);
  assert.equal(markSlots(dead).find(slot => slot.ink === 'fill').color, track);
  assert.equal(markNetwork(dead), 'wifi');
});

test('cellular lights its bars from the left', () => {
  const markup = gauge({ network: '5g', bars: 2, battery: 63, volume: 64 });
  assert.equal(markNetwork(markup), '5g');
  assert.deepEqual(markSlots(markup).map(slot => slot.color), [ink, ink, track, track]);
  assert.doesNotMatch(markup, /<path d="M43\.2/);
});

test('the transport stays in the icon: every network keeps the bottom opening for the volume', () => {
  for (const network of ['wifi', 'cellular', 'eth', 'none']) {
    const markup = gauge({ network, bars: 1, battery: 40, volume: 7 });
    assert.equal(volumeText(markup), '7', network);
  }
  // No connection at all: the bars stay grey, but the reading still shows.
  const dead = gauge({ network: 'none', bars: 0, battery: 40, volume: 64 });
  assert.equal(volumeText(dead), '64');
  assert.deepEqual(markSlots(dead).map(slot => slot.color), [track, track, track, track]);
});

test('an unreadable battery empties its own slots without taking the rest down', () => {
  const markup = gauge({ network: 'wifi', bars: 3, battery: -1, volume: 50 });
  // Nothing to read means nothing to label: neither the digits nor their icon are drawn.
  assert.doesNotMatch(markup, /battery-number|battery-icon/);
  assert.equal(ringOffsets(markup).battery, 107);
  // Half the meter is four full ticks.
  assert.deepEqual(tickOffsets(markup), [0, 0, 0, 0, 100, 100, 100, 100]);
  assert.match(markup, /class="mark"/);
});

test('out-of-range and hostile input cannot reach the markup', () => {
  const clamped = gauge({ network: 'wifi', bars: 99, battery: 150, volume: 300 });
  assert.equal(numberText(clamped), '100');
  assert.deepEqual(ringOffsets(clamped), { battery: 0 });
  assert.deepEqual(tickOffsets(clamped), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(markSlots(clamped).filter(slot => slot.ink === 'stroke').map(slot => slot.color),
    [ink, ink, ink]);
  // An unrecognised transport falls back to "none" rather than reaching the markup as written.
  const hostile = gauge({ network: '<img src=x>', bars: 2, battery: 40, volume: 10 });
  assert.doesNotMatch(hostile, /<img|src=x/);
  assert.equal(markNetwork(hostile), 'none');
  assert.equal(numberText(hostile), '40');
});

test('the parsed values are what the markup renders, so an update can skip the string builder', () => {
  assert.equal(phoneGaugeValues({ network: 'bogus', battery: 40, volume: 10 }).network, 'none');
  assert.deepEqual(phoneGaugeValues({ network: 'wifi', battery: 14, volume: 0, bars: 2 }), {
    network: 'wifi', battery: 14, volume: 0, bars: 2, batteryColor: low,
  });
  assert.equal(phoneGaugeValues({ network: 'wifi', battery: 63, volume: 0, charging: true }).batteryColor, charging);
});
