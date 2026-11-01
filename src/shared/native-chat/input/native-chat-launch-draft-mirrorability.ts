import { countAgentTuiInputLines } from '../../agent-tui-input-clear'

/** Longest draft mirrored into chat; a send past the 15-line clear burst relies on the desktop's confirmed second burst. */
const LAUNCH_DRAFT_MIRROR_MAX_LINES = 40

/** Mirror launch context only if TUI input can be cleared. CR/LF fit the bound; Unicode separators/over-budget drafts stay terminal-only. */
export function canMirrorLaunchDraftToNativeChat(text: string): boolean {
  return (
    text.trim().length > 0 &&
    !/[\u2028\u2029]/.test(text) &&
    countAgentTuiInputLines(text) <= LAUNCH_DRAFT_MIRROR_MAX_LINES
  )
}
