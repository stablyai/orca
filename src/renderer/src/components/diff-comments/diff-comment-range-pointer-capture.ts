// Capture preserves releases outside the window; test DOMs may lack it.
export function capturePointer(node: HTMLElement, pointerId: number): void {
  if (typeof node.setPointerCapture !== 'function') {
    return
  }
  try {
    node.setPointerCapture(pointerId)
  } catch {
    // The pointer is already gone; the document listeners still finish the drag.
  }
}

export function releasePointerCapture(node: HTMLElement, pointerId: number): void {
  if (typeof node.releasePointerCapture !== 'function') {
    return
  }
  try {
    node.releasePointerCapture(pointerId)
  } catch {
    // Capture was never taken or already lost.
  }
}
