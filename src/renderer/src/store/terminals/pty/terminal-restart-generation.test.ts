import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createTerminalRestartActions } from './terminal-restart-state'
import {
  awaitsCodexRestartAnswer,
  blocksCodexPaneInput
} from '../../../components/terminal-pane/account-restart/codex-restart-notice-state'
import type { AppState } from '../../types'

function restartStore() {
  return createStore<AppState>()((set, get) => {
    const slices = {
      codexRestartNoticeByPtyId: {},
      pendingPaneAccountRestarts: {},
      suppressedPtyExitIds: {},
      pendingPtyShutdownIds: {},
      ...createTerminalRestartActions(set, get)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart actions read and write only these slices.
    return slices as unknown as AppState
  })
}

describe('restart notice generations', () => {
  it('an answer for B never carries over to a newer C question', () => {
    const store = restartStore()
    const notice = (nextAccountId: string) => ({
      ptyId: 'pty-a',
      previousAccountLabel: 'A',
      previousAccountId: 'account-a',
      nextAccountLabel: nextAccountId,
      nextAccountId
    })
    store.getState().markCodexRestartNotices([notice('account-b')])
    const asked = store.getState().codexRestartNoticeByPtyId['pty-a']
    store.getState().queuePaneAccountRestarts(['pty-a'], 'codex')
    // Re-marking the same target keeps the answer and its generation.
    store.getState().markCodexRestartNotices([notice('account-b')])
    const answered = store.getState().codexRestartNoticeByPtyId['pty-a']
    expect(answered?.generation).toBe(asked?.generation)
    expect(awaitsCodexRestartAnswer(answered)).toBe(false)
    // The user selects C while the B request is still running: a new, unanswered question.
    store.getState().markCodexRestartNotices([notice('account-c')])
    const current = store.getState().codexRestartNoticeByPtyId['pty-a']
    expect(current?.generation).not.toBe(asked?.generation)
    expect(awaitsCodexRestartAnswer(current)).toBe(true)
    expect(blocksCodexPaneInput(current)).toBe(true)
    expect(store.getState().pendingPaneAccountRestarts['pty-a']).toBeUndefined()
  })
})
