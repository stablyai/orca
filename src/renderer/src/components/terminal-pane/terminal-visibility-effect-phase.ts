export type TerminalVisibilityEffectPhase = 'layout' | 'passive'

export function getTerminalVisibilityEffectPhase(
  platform: NodeJS.Platform
): TerminalVisibilityEffectPhase {
  return platform === 'darwin' ? 'layout' : 'passive'
}
