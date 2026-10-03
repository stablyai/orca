import {
  colorQueryReplyColorsEqual,
  getPtyOwnerHostColors,
  isPtyOwnerProjectMapKnown,
  resolvePtyOwnerColorQueryColors
} from './pty-owner-color-query-colors'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import { TerminalOscColorOverrideTracker } from './terminal-osc-color-override-tracker'
import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors,
  type TerminalOscColorQuerySlot
} from './terminal-osc-color-reply'

type SpawnColorsStanding = 'standing' | 'retired'

/** What one PTY's owner reports for OSC 10/11: the theme, with anything the app set on top. */
export class PtyOwnerColorQueryReplies {
  private readonly overrides = new TerminalOscColorOverrideTracker()
  // The host colours this owner knew when the PTY spawned; the spawn colours describe the
  // pane as painted against them.
  private readonly hostColorsAtSpawn = getPtyOwnerHostColors()
  private spawnColors: SpawnColorsStanding = 'standing'

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

  private themeColors(): TerminalOscColorQueryReplyColors {
    const viewer = this.resolveHostColors()
    return this.spawnColorsStand()
      ? resolvePtyOwnerColorQueryColors(this.intent?.colors, viewer)
      : resolvePtyOwnerColorQueryColors(viewer, this.intent?.colors)
  }

  /**
   * Why the spawn colours can win: the pane sent its own theme at spawn, which already includes
   * a project theme this owner may not have been told about yet. They stand only while the owner
   * has learned nothing newer — it knows host colours, they are the ones the pane spawned
   * against, and no project map has arrived — and retire for good once it has.
   */
  private spawnColorsStand(): boolean {
    if (this.spawnColors === 'retired') {
      return false
    }
    const host = getPtyOwnerHostColors()
    if (
      !host ||
      isPtyOwnerProjectMapKnown() ||
      !colorQueryReplyColorsEqual(host, this.hostColorsAtSpawn)
    ) {
      this.spawnColors = 'retired'
      return false
    }
    return true
  }
}
