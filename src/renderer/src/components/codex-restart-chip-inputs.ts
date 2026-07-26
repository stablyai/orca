import type { AppState } from '@/store/types'

export type CodexRestartInputsState = Pick<AppState, 'ptyIdsByTabId' | 'codexRestartNoticeByPtyId'>

export type CodexRestartInputs = CodexRestartInputsState

// Why: shared frozen bundle returned while no Codex restart notice exists — the
// overwhelmingly common case. CodexRestartChip is mounted once per worktree
// Terminal (visible AND hidden-measurable) and once per split group, and reads
// these two maps only to find panes carrying a restart notice, which appear only
// on a Codex account switch. BOTH churn on unrelated pty lifecycle:
// ptyIdsByTabId gets a fresh identity on every pty register/attach/detach, and
// codexRestartNoticeByPtyId is re-spread into a new object even when empty on the
// pty exit/teardown path (terminals.ts clearTabPtyId). Subscribing to either
// re-rendered every mounted chip on that churn. Gate both behind notice-existence
// so idle chips keep the same reference and stop reacting; behavior is identical
// (no notice -> [] stale ids -> null render). Frozen so the singleton can't be
// mutated.
export const EMPTY_CODEX_RESTART_INPUTS: CodexRestartInputs = Object.freeze({
  ptyIdsByTabId: {},
  codexRestartNoticeByPtyId: {}
})

/**
 * Expose the pty and restart-notice maps to the chip only while at least one
 * Codex restart notice is live; otherwise return a stable frozen bundle so a
 * `useShallow` subscription skips re-renders on unrelated pty-lifecycle churn.
 */
export function selectCodexRestartInputs(s: CodexRestartInputsState): CodexRestartInputs {
  if (Object.keys(s.codexRestartNoticeByPtyId).length === 0) {
    return EMPTY_CODEX_RESTART_INPUTS
  }
  return {
    ptyIdsByTabId: s.ptyIdsByTabId,
    codexRestartNoticeByPtyId: s.codexRestartNoticeByPtyId
  }
}
