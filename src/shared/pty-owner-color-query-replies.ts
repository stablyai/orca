import {
  getPtyOwnerHostColors,
  resolvePtyOwnerColorQueryColors
} from './pty-owner-color-query-colors'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import { COLOR_SCHEME_QUERY, type PtyStartupQuery } from './pty-startup-query'
import { TerminalOscColorOverrideTracker } from './terminal-osc-color-override-tracker'
import {
  cssColorToOscRgb,
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'
import {
  MAX_APPEARANCE_OSC_BODY_CHARS,
  SPECIAL_COLOR_IDENTS,
  terminalOscAppearanceSets,
  type TerminalOscAppearanceEntry
} from './terminal-osc-appearance-query'
import {
  formatXColorRgbSpec,
  parseXColorSpec,
  terminalColorSchemeReport
} from './terminal-view-attributes'

const MAX_QUERY_CANDIDATE_CHARS = 64
// Room for the `ESC ] 4 ;` prefix and terminator around the longest palette body.
const MAX_APPEARANCE_QUERY_CANDIDATE_CHARS = MAX_APPEARANCE_OSC_BODY_CHARS + 16

/** What one PTY's owner reports for OSC 10/11: the theme, with anything the app set on top. */
export class PtyOwnerColorQueryReplies {
  private readonly overrides: TerminalOscColorOverrideTracker

  constructor(
    private readonly intent: PtyStartupIngressIntent | undefined,
    private readonly resolveHostColors: () => TerminalOscColorQueryReplyColors | null = getPtyOwnerHostColors
  ) {
    this.overrides = new TerminalOscColorOverrideTracker(this.ownsAppearance)
  }

  /** A launcher-pinned PTY's owner is its only theme responder, so viewers and the host never answer it. */
  get ownsAppearance(): boolean {
    return this.intent?.launcherColors !== undefined
  }

  /** Held torn candidates are bounded; a torn palette query of every slot must still be held, or the viewers would
   *  answer it with another theme. */
  holdsCandidate(candidate: string): boolean {
    return (
      candidate.length <=
      (this.ownsAppearance ? MAX_APPEARANCE_QUERY_CANDIDATE_CHARS : MAX_QUERY_CANDIDATE_CHARS)
    )
  }

  /** Torn CSI is released at barriers unless it can still become the ?996n this owner answers for the PTY's life;
   *  a held prefix is only invisible control bytes, while releasing it would let the viewers answer the query. */
  releasesTornCsi(pending: string | undefined): boolean {
    return (
      !!pending?.startsWith('\x1b[') &&
      !(this.ownsAppearance && COLOR_SCHEME_QUERY.startsWith(pending))
    )
  }

  /** The SETs of a mixed OSC, which the viewers paint with whether or not its replies landed. */
  forwardedSets(query: PtyStartupQuery): string {
    return query.kind === 'appearance' ? terminalOscAppearanceSets(query.entries) : ''
  }

  /** What to emit in the query's place once answered (its SETs, for a mixed OSC), or null to pass it on. Answered
   *  means the first reply landed (a failed write stops the rest in order) or a pinned query was consumed silently,
   *  since silence beats another theme's contradicting answer. */
  answer(query: PtyStartupQuery, deliver: (reply: string) => boolean): string | null {
    switch (query.kind) {
      case 'match': {
        const replies = this.replies(query.slots)
        return replies.length > 0 && deliverAll(replies, deliver) ? '' : null
      }
      case 'appearance':
        return deliverAll(this.appearanceReplies(query.entries), deliver)
          ? this.forwardedSets(query)
          : null
      case 'color-scheme':
        return deliverAll(this.colorSchemeReplies(), deliver) ? '' : null
      case 'kitty':
      case 'partial':
      case 'none':
        return null
    }
  }

  /** Every byte the PTY emits, so app-set colours are seen in stream order. */
  observe(data: string): void {
    this.overrides.scan(data, () => this.themeColors())
  }

  replies(slots: readonly TerminalOscColorQuerySlot[]): readonly string[] {
    return terminalOscColorQueryReplies(this.currentColors(), slots) ?? []
  }

  /** ?996n from the current foreground/background luminance, as xterm reports it. */
  private colorSchemeReplies(): readonly string[] {
    const colors = this.currentColors()
    const foreground = parseXColorSpec(cssColorToOscRgb(colors.foreground) ?? '')
    const background = parseXColorSpec(cssColorToOscRgb(colors.background) ?? '')
    return foreground && background ? [terminalColorSchemeReport(foreground, background)] : []
  }

  /** Left to right, as xterm runs them: a SET earlier in the sequence shows in a later query's reply. Each slot
   *  replies under its own OSC number; palette and cursor stay silent without the launcher's palette. */
  private appearanceReplies(entries: readonly TerminalOscAppearanceEntry[]): readonly string[] {
    const attributes = this.intent?.launcherAttributes
    return entries.flatMap((entry) => {
      if (entry.spec !== '?') {
        const target =
          entry.kind === 'palette' ? `4;${entry.index}` : SPECIAL_COLOR_IDENTS[entry.slot]
        this.observe(`\x1b]${target};${entry.spec}\x07`)
        return []
      }
      const colors = this.currentColors()
      if (entry.kind === 'palette') {
        const rgb =
          this.overrides.resolvedPaletteColor(entry.index) ?? attributes?.ansi[entry.index]
        return rgb ? [`\x1b]4;${entry.index};${formatXColorRgbSpec(rgb)}\x1b\\`] : []
      }
      if (entry.slot === 'cursor') {
        const cursor = this.overrides.resolvedCursor() ?? attributes?.cursor
        return cursor ? [`\x1b]12;${formatXColorRgbSpec(cursor)}\x1b\\`] : []
      }
      return terminalOscColorQueryReplies(colors, [entry.slot === 'foreground' ? 10 : 11]) ?? []
    })
  }

  private currentColors(): TerminalOscColorQueryReplyColors {
    return this.overrides.resolve(this.themeColors())
  }

  private themeColors(): TerminalOscColorQueryReplyColors {
    return resolvePtyOwnerColorQueryColors(
      this.resolveHostColors(),
      this.intent?.colors,
      this.intent?.launcherColors
    )
  }
}

function deliverAll(replies: readonly string[], deliver: (reply: string) => boolean): boolean {
  return replies.findIndex((reply) => !deliver(reply)) !== 0
}
