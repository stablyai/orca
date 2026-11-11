import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'

/** Output held back from the viewers until a later read resolves it; its timer releases it if nothing does. */
export class PtyIngressHeldSpan {
  private held: PtyIngressSourceSpan | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly holdMs: number,
    private readonly onExpire: () => void
  ) {}

  get span(): PtyIngressSourceSpan | null {
    return this.held
  }

  hold(span: PtyIngressSourceSpan): void {
    this.held = span
    this.timer ??= setTimeout(this.onExpire, this.holdMs)
    this.timer.unref?.()
  }

  take(): PtyIngressSourceSpan | null {
    clearTimeout(this.timer ?? undefined)
    this.timer = null
    const held = this.held
    this.held = null
    return held
  }
}
