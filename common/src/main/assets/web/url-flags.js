// Head units have no reachable devtools, so diagnostics and fault-isolation experiments are
// enabled from the address bar. Every flag is validated against its own whitelist: an unknown
// value behaves exactly like an absent one, so a typo can never leak into the connection state
// machine. Parsing stays regex-based because app.js also runs in VM test harnesses that have no
// URLSearchParams. See docs/URL_FLAGS.md for the complete table and the default user path.
const query = (search, name, pattern) =>
  (String(search || '').match(new RegExp(`[?&]${name}=(${pattern})(?:&|$)`)) || [])[1] || '';

export function readUrlFlags(search = '') {
  // `?audioIdle=<ms>` tunes how long the page keeps its audio output open after the last sound;
  // 0 disables the release entirely for a head unit that needs a permanently open sink.
  const audioIdleRaw = query(search, 'audioIdle', '\\d+');
  return {
    // The drawer's debug button toggles this one flag; the panel and the button must agree.
    diagnostic: query(search, 'diag', '1') !== '',
    // Some embedded browsers never decode an off-screen video element; keep a 1 px layout box.
    keepVideoVisible: query(search, 'unhide', '1') !== '',
    // The page connects automatically by default; ?manual=1 restores the QR/code launch page.
    autoLaunch: query(search, 'manual', '1') === '',
    // Bluetooth-conflict probes: noanswer stops after the offer, inactive holds the media
    // direction back while ICE/DTLS still establishes.
    rtcExperiment: query(search, 'rtcexp', 'noanswer|inactive'),
    // ?ms=1 owns the platform media session; ?ms=2 additionally routes audio through a media
    // element, which is what Chrome requires before it delivers platform media keys to a page.
    mediaSessionMode: query(search, 'ms', '[12]'),
    audioIdleMillis: audioIdleRaw === '' ? 5000 : Math.max(0, Number(audioIdleRaw)),
  };
}
