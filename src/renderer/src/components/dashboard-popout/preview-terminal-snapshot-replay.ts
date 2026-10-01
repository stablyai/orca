import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { parseTerminalKittyKeyboardFlags } from '../../../../shared/terminal-kitty-keyboard-flags'
import { buildKittyKeyboardRestore } from '../../../../shared/terminal-mode-reset-profiles'
import type {
  TerminalPreviewReplayChunk,
  TerminalPreviewSnapshot
} from '../../../../shared/terminal-preview'

/**
 * Apply snapshot + buffered replay, restoring proven kitty flags after the
 * snapshot bytes (snapshot ANSI omits kitty pushes). Synchronous so no browser
 * event observes the temporary reset.
 */
export function replayPreviewConnectionSnapshot(args: {
  snapshot: TerminalPreviewSnapshot
  replay: TerminalPreviewReplayChunk[]
  kittyKeyboardModes: TerminalKittyKeyboardModeTracker
  /** Scans the chunk into the mirror and queues it for xterm. */
  write: (chunk: string, live: boolean) => void
}): void {
  const { snapshot, kittyKeyboardModes } = args
  // Why: carry only live-proven flags across a flagless resync; a fresh mirror's zero is ungrounded.
  const provenFlags =
    parseTerminalKittyKeyboardFlags(snapshot.kittyKeyboardFlags) ??
    (kittyKeyboardModes.hasProvenBaseline ? kittyKeyboardModes.snapshotFlags : undefined)
  kittyKeyboardModes.resetForSnapshot()
  if (snapshot.scrollbackAnsi) {
    args.write(snapshot.scrollbackAnsi, false)
  }
  if (snapshot.data) {
    args.write(snapshot.data, false)
  }
  // Why as bytes: the popout xterm must parse the same restore its mirror scans.
  args.write(buildKittyKeyboardRestore(provenFlags), false)
  if (snapshot.pendingEscapeTailAnsi) {
    args.write(snapshot.pendingEscapeTailAnsi, false)
  }
  for (const chunk of args.replay) {
    args.write(chunk.data, chunk.mode === 'live')
  }
}
