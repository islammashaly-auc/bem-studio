// Buttons keep their normal click action. A deliberate drag resizes instead.
export function bindDrawerHandle(handle, resize) {
  let drag = null;
  let moved = false;

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    moved = false;
    drag = { id:event.pointerId, x:event.clientX, y:event.clientY };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    resize(dx, dy, !moved);
    moved = true;
  });
  handle.addEventListener('lostpointercapture', () => { drag = null; });
  handle.addEventListener('click', event => {
    if (moved && event.detail) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    moved = false;
  }, true);
}
