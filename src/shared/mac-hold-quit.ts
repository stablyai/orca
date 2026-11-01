import { keybindingMatchesInput } from './keybindings'

export const HOLD_QUIT_DURATION_MS = 1000

export type HoldQuitSettings = { holdQuitWhileAgentsWork?: boolean }

export type HoldQuitNotice = {
  phase: 'starting' | 'holding' | 'released' | 'unavailable' | 'dismissed'
}

export type HoldQuitInput = {
  type: string
  key?: string
  code?: string
  meta?: boolean
  control?: boolean
  alt?: boolean
  shift?: boolean
  isAutoRepeat?: boolean
}

export function isHoldQuitChord(input: HoldQuitInput): boolean {
  return keybindingMatchesInput('Cmd+Q', input, 'darwin')
}
