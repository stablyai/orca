import {
  currentMailWakeStartup,
  paneResumeRecord
} from '@/components/terminal-pane/pty-connection/startup/pane-resume-record'
import { hasEmptyReattachRetireEvidence } from '@/components/terminal-pane/pty-connection/reattach/empty-reattach-retire-evidence'
import type { ColdRestoreAgentResumeStartup } from '@/components/terminal-pane/pty-connection/startup/fresh-spawn-types'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

const state = vi.hoisted(
  (): { sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> } => ({
    sleepingAgentSessionsByPaneKey: {}
  })
)
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => state } }))
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { takeSleepingAgentWakeRequest } from './sleeping-agent-wake-requests'

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

it('keeps pre-launch custody on its quit bookmark through an already armed wake without authorizing retirement', () => {
  const original: SleepingAgentSessionRecord = {
    paneKey: 'tab:11111111-1111-4111-8111-111111111111',
    tabId: 'tab',
    worktreeId: 'workspace',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conversation' },
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1,
    prompt: ''
  }
  const retained: SleepingAgentSessionRecord = {
    ...original,
    origin: 'quit',
    restoreOnTabOpenOnly: true,
    mailWake: { id: 'obligation', capturedAt: 1, startedAt: 100 }
  }
  const startup: ColdRestoreAgentResumeStartup = {
    agent: 'codex',
    command: 'codex resume conversation',
    resumeProviderSession: original.providerSession,
    launchToken: 'this-invocation',
    resumeOrigin: 'saved',
    launchConfig: { agentArgs: '', agentEnv: {} },
    useLiveEntry: false,
    hasSleepingRecord: true,
    sleepingRecordEntry: { paneKey: original.paneKey, record: original }
  }
  const current = currentMailWakeStartup(startup, { [original.paneKey]: retained })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bookmark capture reads only pane identity, startup and the bound transport incarnation.
  const session = {
    cacheKey: original.paneKey,
    deps: { tabId: 'tab', worktreeId: 'workspace' },
    remotePtyIncarnationId: 'incarnation',
    transport: { getPtyId: () => 'pty-shell' }
  } as unknown as ConnectPanePtySession
  expect(paneResumeRecord(session, current)).toMatchObject({
    origin: 'quit',
    restoreOnTabOpenOnly: true,
    mailWake: {
      id: 'obligation',
      capturedAt: 1,
      attempt: { ptyId: 'pty-shell', incarnationId: 'incarnation', launchToken: 'this-invocation' }
    }
  })
  expect(hasEmptyReattachRetireEvidence('pty-shell', current)).toBe(false)
  const manual: SleepingAgentSessionRecord = {
    ...original,
    capturedAt: 2,
    restoreOnTabOpenOnly: true
  }
  expect(
    currentMailWakeStartup(startup, { [original.paneKey]: manual }).sleepingRecordEntry?.record
  ).toBe(original)
})
