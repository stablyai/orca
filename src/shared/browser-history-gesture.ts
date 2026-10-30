export const BROWSER_HISTORY_GESTURE_CHANNEL = 'browser:history-gesture'
export const BROWSER_HISTORY_WHEEL_CHANNEL = 'browser:history-wheel'

export type BrowserHistoryWheel = {
  gestureId: number
  deltaX: number
  deltaY: number
  blocked: boolean
}

export class BrowserHistoryGesture {
  private static generation = 0
  private activeId: number | null = null
  private deltaX = 0
  private deltaY = 0
  private blocked = false

  get isTracking(): boolean {
    return this.activeId !== null && !this.blocked
  }

  begin(): number {
    this.activeId = ++BrowserHistoryGesture.generation
    this.deltaX = 0
    this.deltaY = 0
    this.blocked = false
    return this.activeId
  }

  end(): void {
    this.activeId = null
  }

  record(wheel: BrowserHistoryWheel): 'back' | 'forward' | null {
    if (this.activeId === null || wheel.gestureId !== this.activeId || this.blocked) {
      return null
    }
    if (wheel.blocked) {
      this.blocked = true
      return null
    }
    this.deltaX += wheel.deltaX
    this.deltaY += Math.abs(wheel.deltaY)
    if (Math.abs(this.deltaX) + this.deltaY < 12) {
      return null
    }
    if (Math.abs(this.deltaX) < this.deltaY * 2) {
      this.blocked = true
      return null
    }
    if (Math.abs(this.deltaX) < 100) {
      return null
    }
    this.end()
    return this.deltaX < 0 ? 'back' : 'forward'
  }
}
