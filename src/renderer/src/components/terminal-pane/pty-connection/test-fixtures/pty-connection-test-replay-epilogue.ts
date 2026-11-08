import { buildKittyKeyboardRestore } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'

/** A post-replay reset: the profile, then the mirror's kitty restore (a bare pop while unproven). */
export function replayEpilogue(profile: string, provenFlags?: number): string {
  return `${profile}${buildKittyKeyboardRestore(provenFlags)}`
}
