import {
  getPtyOwnerHostColors,
  resolvePtyOwnerColorQueryColors
} from './pty-owner-color-query-colors'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import { TerminalOscColorOverrideTracker } from './terminal-osc-color-override-tracker'
import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'

/** What one PTY's owner reports for OSC 10/11: the theme, with anything the app set on top. */
export class PtyOwnerColorQueryReplies {
  private readonly overrides = new TerminalOscColorOverrideTracker()

  constructor(
    private readonly intent: PtyStartupIngressIntent | undefined,
    private readonly resolveHostColors: () => TerminalOscColorQueryReplyColors | null = getPtyOwnerHostColors
  ) {}

  /** Every byte the PTY emits, so app-set colours are seen in stream order. */
  observe(data: string): void {
    this.overrides.scan(data, () => this.themeColors())
  }

  replies(slots: readonly TerminalOscColorQuerySlot[]): readonly string[] {
    return terminalOscColorQueryReplies(this.overrides.resolve(this.themeColors()), slots) ?? []
  }

  /** True when the first reply landed; a failed write stops the rest in order. */
  answer(delivery: PtyStartupReplyDelivery, slots: readonly TerminalOscColorQuerySlot[]): boolean {
    const replies = this.replies(slots)
    return (
      replies.length > 0 && replies.findIndex((reply) => !delivery.answer(reply, 'owner')) !== 0
    )
  }

  private themeColors(): TerminalOscColorQueryReplyColors {
    return resolvePtyOwnerColorQueryColors(this.resolveHostColors(), this.intent?.colors)
  }
}
