import { expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

const state = vi.hoisted(
  (): { sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> } => ({
    sleepingAgentSessionsByPaneKey: {}
  })
)
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/workspace-mounting/background-terminal-worktree-mount'
import {
  rememberMailWakeLaunchToken,
  mailWakeLaunchToken,
  takeSleepingAgentWakeRequest
} from './sleeping-agent-wake-requests'

it('background mail wake authorizes only its pane when a tab contains several sleeping agents', () => {
  const first: SleepingAgentSessionRecord = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    worktreeId: 'workspace',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'first' },
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    prompt: ''
  }
  const second: SleepingAgentSessionRecord = {
    ...first,
    paneKey: 'tab:22222222-2222-4222-8222-222222222222',
    providerSession: { key: 'session_id', id: 'second' }
  }
  state.sleepingAgentSessionsByPaneKey = { [first.paneKey]: first, [second.paneKey]: second }
  requestBackgroundTerminalWorktreeMount({
    worktreeId: 'workspace',
    tabIds: ['tab'],
    wakePaneKey: first.paneKey
  })
  expect(takeSleepingAgentWakeRequest(first)).toBe(true)
  expect(takeSleepingAgentWakeRequest(second)).toBe(false)
})

it("a mail wake's launch token belongs to the record it was given for", () => {
  const slept: SleepingAgentSessionRecord = {
    paneKey: 'tab:33333333-3333-4333-8333-333333333333',
    tabId: 'tab',
    worktreeId: 'workspace',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'slept' },
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    prompt: ''
  }
  state.sleepingAgentSessionsByPaneKey = { [slept.paneKey]: slept }
  rememberMailWakeLaunchToken(slept.paneKey, 'attempt-1')
  const replaced = { ...slept, capturedAt: 2 }
  state.sleepingAgentSessionsByPaneKey = { [slept.paneKey]: replaced }
  expect(mailWakeLaunchToken(replaced)).toBeUndefined()
  expect(mailWakeLaunchToken(slept)).toBe('attempt-1')
  // A probe that builds the startup first leaves the real launch the same attempt id.
  expect(mailWakeLaunchToken(slept)).toBe('attempt-1')
})
