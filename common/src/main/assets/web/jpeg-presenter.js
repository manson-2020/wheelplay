// At most two decodes plus the displayed frame. Newer commits retire older work.
export function createJpegPresenter(images, { onFrame, onError = () => {},
  createUrl = data => URL.createObjectURL(data), revokeUrl = url => URL.revokeObjectURL(url),
} = {}) {
  let front = null, generation = 0, nextOrder = 0, committedOrder = 0;
  const urls = new Map(), pending = new Map();
  function discard(image) {
    image.onload = image.onerror = null; image.removeAttribute('src'); image.hidden = true;
    if (urls.has(image)) revokeUrl(urls.get(image)); urls.delete(image);
  }
  function retire(image) {
    const work = pending.get(image); if (!work) return;
    pending.delete(image); discard(image); work.done();
  }
  function cancelPending() {
    generation++;
    for (const image of [...pending.keys()]) retire(image);
  }
  return {
    load(data, meta, valid, done) {
      let image = images.find(item => item !== front && !pending.has(item));
      if (!image || pending.size >= Math.min(2, images.length - 1)) {
        image = pending.keys().next().value; retire(image);
      }
      const work = { done, order: ++nextOrder }, token = generation;
      pending.set(image, work); image.hidden = true;
      const url = createUrl(data); urls.set(image, url);
      image.onload = () => {
        if (token !== generation || pending.get(image) !== work) return;
        pending.delete(image); image.onload = image.onerror = null;
        if (work.order <= committedOrder || !valid() || !image.naturalWidth || !image.naturalHeight) { discard(image); done(); return; }
        const previous = front;
        const accepted = onFrame(meta, image.naturalWidth, image.naturalHeight);
        if (token !== generation) { done(); return; }
        if (accepted === false) { discard(image); done(); return; }
        committedOrder = work.order;
        front = image; image.hidden = false;
        if (previous) discard(previous);
        for (const [other, older] of [...pending]) if (older.order < work.order) retire(other);
        done();
      };
      image.onerror = () => {
        if (token !== generation || pending.get(image) !== work) return;
        pending.delete(image); discard(image); done(); onError(meta);
      };
      image.src = url;
    },
    cancelPending,
    hide() { if (front) front.hidden = true; },
    show() { if (front) front.hidden = false; },
    clear() { cancelPending(); images.forEach(discard); front = null; },
    get current() { return front; },
  };
}

