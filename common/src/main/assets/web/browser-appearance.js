// The head unit's own light/dark preference is the only appearance signal a browser exposes.
// "Follow browser" turns that media query into CarPlay's night mode, so the page reports it on
// every (re)connect, whenever it flips, and whenever the page is shown again: a head unit normally
// leaves the page to change its appearance, and not every embedded Chromium delivers the `change`
// event for that. A browser without the media query reports nothing, leaving the phone on the
// Android value instead of forcing one appearance.
export function createAppearanceReporter({
  send, query = () => window.matchMedia('(prefers-color-scheme: dark)'), onChange = () => {},
} = {}) {
  let media = null, attached = false;
  function report() {
    if (!media) return;
    const dark = Boolean(media.matches);
    onChange(dark);
    send({ type: 'browser-appearance', dark });
  }
  function attach() {
    if (attached) return;
    try { media = query() || null; } catch (_) { media = null; }
    if (!media) return;
    if (typeof media.addEventListener === 'function') media.addEventListener('change', report);
    else if (typeof media.addListener === 'function') media.addListener(report);
    attached = true;
  }
  return {
    open() { attach(); report(); },
    // Re-read when the page is shown again; never deduplicated, because a reconnected socket has
    // no memory of what the previous connection reported.
    refresh() { attach(); report(); },
    close() {
      if (!media) return;
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', report);
      else if (typeof media.removeListener === 'function') media.removeListener(report);
      media = null; attached = false;
    },
  };
}

// Verification bridge for head-unit steering wheel media keys. Chrome only hands those keys to
// the tab that owns the platform media session, so this registers the handlers and reports every
// action back over the control socket: the phone log then separates "the key never reached the
// page" from "the page got it but the rest of the chain failed". No playback control yet.
// Publishes the head unit media card (title, artist, artwork) and, when keys are enabled, forwards
// platform media keys over the control socket. Metadata is always published; `?ms=1` only adds the
// action handlers, because forwarding a key is a behaviour change while a label is not.
export function createMediaSessionProbe({
  session = typeof navigator !== 'undefined' ? navigator.mediaSession : null,
  send, onAction = () => {}, now = () => Date.now(), handlers = true,
  actions = ['play', 'pause', 'nexttrack', 'previoustrack', 'seekbackward', 'seekforward'],
} = {}) {
  if (!session || typeof session.setActionHandler !== 'function') {
    return { available: false, last: null, apply() {} };
  }
  let last = null, artwork = null;
  let fields = { title: 'WheelPlay', artist: 'CarPlay' };
  function publish() {
    try {
      const metadata = artwork
        ? { ...fields, artwork: [{ src: artwork, sizes: '512x512', type: 'image/jpeg' }] }
        : fields;
      session.metadata = typeof MediaMetadata === 'function' ? new MediaMetadata(metadata) : metadata;
      // Chrome releases the platform session as soon as a page reports "paused", and the head unit
      // then stops delivering the key, so a key-forwarding session always claims to be playing.
      if (handlers) session.playbackState = 'playing';
    } catch (_) {}
  }
  function apply(media = {}) {
    if (media.title || media.artist) {
      fields = { title: String(media.title || 'WheelPlay'), artist: String(media.artist || 'CarPlay') };
    }
    if (media.artwork) artwork = media.artwork;
    publish();
  }
  function press(action) {
    last = { action, at: now() }; onAction(action); send({ type: 'media', action }); publish();
  }
  if (handlers) {
    for (const action of actions) {
      try { session.setActionHandler(action, () => press(action)); } catch (_) {}
    }
  }
  publish();
  return { available: true, apply, get last() { return last; } };
}

