import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import {
  applyCrossMachineRecoveryOp,
  type CrossMachineRecoveryApplyOp,
  type RecoveryWorkspaceFragment
} from './cross-machine-recovery-session-ops'
import { getDefaultWorkspaceSession } from './constants'

function record(paneKey: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: 'tab',
    worktreeId: 'wt',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    launchConfig: { agentArgs: '', agentEnv: {} },
    origin: 'recovery',
    restoreOnTabOpenOnly: false,
    recovery: { importKey: 'k', sourcePaneKey: 'src' }
  }
}

describe('applyCrossMachineRecoveryOp merge-records', () => {
  it('drops a concurrent replay twin minted under another pane key', () => {
    const first = applyCrossMachineRecoveryOp(getDefaultWorkspaceSession(), {
      kind: 'merge-records',
      records: [record('tab:leaf-a')]
    })
    const second = applyCrossMachineRecoveryOp(first.session, {
      kind: 'merge-records',
      records: [record('tab:leaf-b')]
    })
    expect(Object.keys(second.session.sleepingAgentSessionsByPaneKey ?? {})).toEqual(['tab:leaf-a'])
  })
})

function fragment(): RecoveryWorkspaceFragment {
  return {
    worktreeId: 'wt',
    terminalTabs: [
      {
        id: 'tab',
        worktreeId: 'wt',
        ptyId: null,
        title: 'claude',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ],
    terminalLayoutsByTabId: {},
    unifiedTabs: [],
    tabGroups: [],
    tabGroupLayout: null,
    activeGroupId: null,
    openFiles: [],
    activeFileId: null,
    browserWorkspaces: [],
    browserPagesByWorkspace: {},
    activeBrowserTabId: null,
    activeTabType: 'terminal',
    activeTabId: 'tab'
  }
}

function importOp(importKey: string): CrossMachineRecoveryApplyOp {
  return { kind: 'import', importKey, fragment: fragment(), records: [] }
}

describe('applyCrossMachineRecoveryOp import', () => {
  it('records the import key in the same session as the layout', () => {
    const { session, outcome } = applyCrossMachineRecoveryOp(
      getDefaultWorkspaceSession(),
      importOp('k')
    )

    expect(outcome).toEqual({ ok: true, claimed: null })
    expect(session.tabsByWorktree.wt?.map((tab) => tab.id)).toEqual(['tab'])
    expect(session.recoveryImportKeyByWorktreeId).toEqual({ wt: 'k' })
  })

  it('reports a layout its own import key already landed, even after its tabs closed', () => {
    const landed = applyCrossMachineRecoveryOp(getDefaultWorkspaceSession(), importOp('k')).session
    const closed = { ...landed, tabsByWorktree: { wt: [] } }

    for (const session of [landed, closed]) {
      const replay = applyCrossMachineRecoveryOp(session, importOp('k'))
      expect(replay.outcome).toEqual({ ok: true, claimed: null, alreadyApplied: true })
      expect(replay.session).toBe(session)
    }
  })

  it('refuses another import over tabs a different import key applied', () => {
    const landed = applyCrossMachineRecoveryOp(getDefaultWorkspaceSession(), importOp('k')).session

    expect(applyCrossMachineRecoveryOp(landed, importOp('other')).outcome).toEqual({
      ok: false,
      code: 'recovery_destination_not_empty'
    })
  })
})
