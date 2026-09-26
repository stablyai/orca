import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import { applyCrossMachineRecoveryOp } from './cross-machine-recovery-session-ops'
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
