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
  it('a refused request for B leaves the newer C notice visible and answerable', () => {
    const store = restartStore()
    const notice = (nextAccountId: string) => ({
      ptyId: 'pty-a',
      previousAccountLabel: 'A',
      previousAccountId: 'account-a',
      nextAccountLabel: nextAccountId,
      nextAccountId
    })
    store.getState().markCodexRestartNotices([notice('account-b')])
    store.getState().queuePaneAccountRestarts(['pty-a'], 'codex')
    // The user selects C while the B request is still running.
    store.getState().markCodexRestartNotices([notice('account-c')])
    const inherited = store.getState().codexRestartNoticeByPtyId['pty-a']
    expect(blocksCodexPaneInput(inherited)).toBe(true)
    expect(awaitsCodexRestartAnswer(inherited)).toBe(false)
    // The B reply settles by reopening the current prompt.
    store.getState().reopenCodexRestartPrompt('pty-a')
    const current = store.getState().codexRestartNoticeByPtyId['pty-a']
    expect(current?.nextAccountId).toBe('account-c')
    expect(awaitsCodexRestartAnswer(current)).toBe(true)
  })
})
