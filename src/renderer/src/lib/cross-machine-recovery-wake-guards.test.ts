import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { isDurableSleepingCapture } from '../store/slices/agent-status-sleeping-records'
import { isPassiveCompletedHibernationEvidence } from './sleeping-agent-pane-ownership'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'

const recoveryRecord: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:3c2b1a00-0000-4000-8000-000000000001',
  tabId: 'tab-1',
  worktreeId: 'repo::/wt',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  launchConfig: { agentArgs: '', agentEnv: {} },
  origin: 'recovery',
  restoreOnTabOpenOnly: false,
  recovery: { importKey: 'key', sourcePaneKey: 'src-tab:src-leaf' }
}

describe('cross-machine recovery wake guards', () => {
  it('never launches or discards an imported recovery record', () => {
    expect(launchSleepingAgentSession(recoveryRecord)).toBe(false)
    expect(isDurableSleepingCapture(recoveryRecord)).toBe(true)
    expect(isPassiveCompletedHibernationEvidence(recoveryRecord)).toBe(false)
  })
})
