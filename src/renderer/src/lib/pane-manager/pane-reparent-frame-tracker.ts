/** Tracks the animation frames issued for drag-reparent work so destroy() can
 *  cancel every still-pending one, and skips the callback once the owner died. */
export class PaneReparentFrameTracker {
  private pendingPaneReparentFrameIds = new Set<number>()

  constructor(private readonly isDestroyed: () => boolean) {}

  request(callback: FrameRequestCallback): void {
    let completed = false
    let frameId: number | undefined
    frameId = requestAnimationFrame((timestamp) => {
      completed = true
      if (frameId !== undefined) {
        this.pendingPaneReparentFrameIds.delete(frameId)
      }
      if (!this.isDestroyed()) {
        callback(timestamp)
      }
    })
    if (!completed) {
      this.pendingPaneReparentFrameIds.add(frameId)
    }
  }

  cancelPending(): void {
    for (const frameId of this.pendingPaneReparentFrameIds) {
      cancelAnimationFrame(frameId)
    }
    this.pendingPaneReparentFrameIds.clear()
  }
}
