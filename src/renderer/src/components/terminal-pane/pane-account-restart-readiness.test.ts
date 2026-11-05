import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  isAccountRestartReady,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

describe('Claude account restart readiness', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      pendingPaneAccountRestarts: { 'pty-1': 'claude' },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      }
    })
  })

  it('allows a usage-limit StopFailure while only a background shell keeps the row working', () => {
    const hooks = createHookListenerState()
    normalizeHookPayload(
      hooks,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'start a server' }
      },
      'production'
    )
    const stopped = normalizeHookPayload(
      hooks,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'StopFailure',
          error: 'rate_limit',
          background_tasks: [{ id: 'server', type: 'shell', status: 'running' }]
        }
      },
      'production'
    )!
    expect(stopped).toMatchObject({
      hookEventName: 'StopFailure',
      claudeRunningNonAgentTask: true,
      payload: { state: 'working', mainAgent: { state: 'done', outcome: 'failure' } }
    })
    useAppStore.getState().setAgentStatus(PANE_KEY, stopped.payload)

    expect(selectReadyAccountRestartPtyIds(useAppStore.getState(), 'tab-1')).toEqual(['pty-1'])
    expect(isAccountRestartReady(useAppStore.getState(), 'tab-1', LEAF_ID, 'pty-1')).toBe(true)

    useAppStore.getState().setAgentStatus(PANE_KEY, {
      prompt: '',
      agentType: 'claude',
      state: 'working',
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 },
      subagents: [{ id: 'child', state: 'working', startedAt: 1 }]
    })

    expect(selectReadyAccountRestartPtyIds(useAppStore.getState(), 'tab-1')).toEqual([])
  })
})
