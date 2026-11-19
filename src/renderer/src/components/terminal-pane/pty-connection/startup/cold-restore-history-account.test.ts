// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { prepareAiVaultTerminalResumeRequest } from '@/lib/agent-session/resume/history/ai-vault-session-resume-preparation'
import { commitHistorySessionResume } from '@/lib/agent-session/resume/history/history-resume-receipts'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import {
  prepareColdRestoreHistoryAccount,
  spawnColdRestoreWithAccount
} from './cold-restore-history-account'

vi.mock('@/lib/agent-session/resume/history/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultTerminalResumeRequest: vi.fn()
}))
vi.mock('@/lib/agent-session/resume/history/history-resume-receipts', () => ({
  commitHistorySessionResume: vi.fn(async () => {})
}))

const initialState = useAppStore.getState()
const oldId = '00000000-0000-4000-8000-000000000001'
const newId = '00000000-0000-4000-8000-000000000002'
const filePath = `C:\\data\\codex-runtime-home\\home\\sessions\\2026\\11\\19\\rollout-${oldId}.jsonl`
const newPath = `C:\\data\\codex-accounts\\chosen\\home\\sessions\\2026\\11\\19\\rollout-${newId}.jsonl`

function startup(): ColdRestoreAgentResumeStartup {
  return {
    agent: 'codex',
    command: `codex resume ${oldId}`,
    resumeProviderSession: { key: 'session_id', id: oldId, transcriptPath: filePath },
    resumeOrigin: 'saved',
    resumeSource: { cancelled: false },
    launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
    launchToken: 'launch-token',
    useLiveEntry: false,
    hasSleepingRecord: false,
    sleepingRecordEntry: null
  }
}

function prepare(saved = startup(), owner = 'local') {
  return prepareColdRestoreHistoryAccount(
    saved,
    {
      agent: 'codex',
      providerSession: saved.resumeProviderSession,
      cmdOverrides: {},
      platform: 'win32',
      shell: 'cmd'
    },
    'folder:project',
    owner
  )
}

function session() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the account preparation, hold and current-pane checks use this fixture.
  return {
    cacheKey: 'tab:leaf',
    disposed: false,
    tabGeneration: 0,
    waitTeardowns: [],
    deps: { worktreeId: 'folder:project', tabId: 'tab' },
    applyColdRestoreAgentResumeStartup: vi.fn(),
    startFreshSpawn: vi.fn(async () => 'pty-chosen'),
    reportError: vi.fn()
  } as unknown as ConnectPanePtySession
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ deleteStateByWorktreeId: {}, tabsByWorktree: {} })
  vi.mocked(prepareAiVaultTerminalResumeRequest).mockResolvedValue({
    useRealCodexHome: false,
    workspaceAccountPrepared: true,
    substituteSessionId: newId,
    substituteTranscriptPath: newPath,
    substituteCodexHome: 'C:\\data\\codex-accounts\\chosen\\home',
    resumeReceipt: 'chosen-receipt'
  })
})
afterEach(() => useAppStore.setState(initialState, true))

it('prepares a legacy saved restore before spawning and records the chosen version after it opens', async () => {
  const pane = session()
  const saved = prepare()
  expect(await spawnColdRestoreWithAccount(pane, saved, {})).toBe('pty-chosen')
  expect(prepareAiVaultTerminalResumeRequest).toHaveBeenCalledWith(
    expect.objectContaining({ filePath, sessionId: oldId, executionHostId: 'local' }),
    'folder:project'
  )
  const opened = vi.mocked(pane.startFreshSpawn).mock.calls[0][0]
  expect(opened?.command).toContain(newId)
  expect(opened?.command).not.toContain(oldId)
  expect(opened?.env?.ORCA_HISTORY_RESUME_RECEIPT).toBe('chosen-receipt')
  expect(commitHistorySessionResume).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: newId,
      filePath: newPath,
      resumeReceipt: 'chosen-receipt'
    })
  )
})

it('leaves private-home, WSL and remote restores on their existing preparation path', () => {
  const privateSaved = startup()
  privateSaved.resumeProviderSession.transcriptPath = newPath
  expect(prepare(privateSaved)).toBe(privateSaved)
  const wslSaved = startup()
  wslSaved.resumeProviderSession.transcriptPath = `\\\\wsl.localhost\\Ubuntu\\home\\user\\codex-runtime-home\\home\\sessions\\2026\\11\\19\\rollout-${oldId}.jsonl`
  expect(prepare(wslSaved)).toBe(wslSaved)
  const remoteSaved = startup()
  expect(prepare(remoteSaved, 'runtime:other')).toBe(remoteSaved)
})

it('keeps a cancelled account choice resumable without spawning or reporting a terminal failure', async () => {
  vi.mocked(prepareAiVaultTerminalResumeRequest).mockRejectedValue(
    new DOMException('Resume cancelled', 'AbortError')
  )
  const pane = session()
  expect(await spawnColdRestoreWithAccount(pane, prepare(), {})).toBeNull()
  expect(pane.startFreshSpawn).not.toHaveBeenCalled()
  expect(pane.reportError).not.toHaveBeenCalled()
  expect(commitHistorySessionResume).not.toHaveBeenCalled()
})

it('does not spawn after the pane is disposed while choosing an account', async () => {
  const pane = session()
  const saved = prepare()
  const opening = spawnColdRestoreWithAccount(pane, saved, {})
  pane.disposed = true
  expect(await opening).toBeNull()
  expect(pane.startFreshSpawn).not.toHaveBeenCalled()
  expect(commitHistorySessionResume).not.toHaveBeenCalled()
})

it('does not record an account when terminal creation fails', async () => {
  const pane = session()
  vi.mocked(pane.startFreshSpawn).mockResolvedValue(null)
  expect(await spawnColdRestoreWithAccount(pane, prepare(), {})).toBeNull()
  expect(commitHistorySessionResume).not.toHaveBeenCalled()
})
