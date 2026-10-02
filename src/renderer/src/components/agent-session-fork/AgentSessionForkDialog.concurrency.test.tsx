/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import {
  DIRTY_ENTRIES,
  HEAD_OID,
  bodyText,
  carrySwitch,
  renderDialog,
  session,
  statusWith,
  submitWithEnter,
  unmountDialogs
} from './AgentSessionForkDialog.test-fixture'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  runAgentSessionFork: vi.fn(),
  getRuntimeGitStatus: vi.fn(),
  isWorkingTreeCarrySupported: vi.fn(),
  listForkableAgentSessions: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  toastLoading: vi.fn(),
  toastDismiss: vi.fn()
}))

const sourceWorktree = {
  id: 'repo::wt',
  repoId: 'repo',
  displayName: 'Fix auth',
  branch: 'refs/heads/feature/auth',
  path: '/repos/wt'
}

const settings = { activeRuntimeEnvironmentId: null }

const initialModalData: Record<string, unknown> = {}

const state = {
  activeModal: 'agent-session-fork',
  modalData: initialModalData,
  closeModal: vi.fn(),
  agentStatusByPaneKey: {},
  retainedAgentsByPaneKey: {},
  sleepingAgentSessionsByPaneKey: {},
  agentLaunchConfigByPaneKey: {},
  repos: [{ id: 'repo', connectionId: 'ssh-1' }],
  settings,
  getKnownWorktreeById: (id: string) => (id === sourceWorktree.id ? sourceWorktree : undefined)
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/store/selectors', () => ({
  useRepoMap: () => new Map(),
  useWorktreesForRepo: () => []
}))

vi.mock('@/store/repos/owner-routing', () => ({
  settingsForRepoOwner: () => settings
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('sonner', () => ({
  toast: {
    warning: mocks.toastWarning,
    error: mocks.toastError,
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss
  }
}))

vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitStatus: mocks.getRuntimeGitStatus
}))

vi.mock('@/runtime/runtime-git-working-tree-carry-client', () => ({
  isWorkingTreeCarrySupported: mocks.isWorkingTreeCarrySupported
}))

vi.mock('@/lib/agent-session-fork-flow', () => ({
  runAgentSessionFork: mocks.runAgentSessionFork,
  copyTranscriptPrompt: vi.fn()
}))

vi.mock('@/lib/worktree-agent-fork-sessions', () => ({
  listForkableAgentSessions: mocks.listForkableAgentSessions
}))

vi.mock('@/components/repo/CreateFromPicker', () => ({ CreateFromPicker: () => null }))

beforeEach(() => {
  state.activeModal = 'agent-session-fork'
  state.modalData = {
    sourceWorktreeId: 'repo::wt',
    launchSource: 'sidebar',
    preselectedPaneKey: null,
    transcript: null
  }
  state.closeModal.mockReset()
  mocks.runAgentSessionFork.mockReset()
  mocks.runAgentSessionFork.mockResolvedValue({ ok: true, worktreeId: 'repo::child', warnings: [] })
  mocks.getRuntimeGitStatus.mockReset()
  mocks.getRuntimeGitStatus.mockResolvedValue(statusWith([]))
  mocks.isWorkingTreeCarrySupported.mockReset()
  mocks.isWorkingTreeCarrySupported.mockResolvedValue(true)
  mocks.listForkableAgentSessions.mockReset()
  mocks.listForkableAgentSessions.mockReturnValue([session('s1')])
  mocks.toastWarning.mockReset()
  mocks.toastError.mockReset()
  mocks.toastLoading.mockReset()
  mocks.toastLoading.mockReturnValue('fork-progress')
  mocks.toastDismiss.mockReset()
})

afterEach(() => {
  unmountDialogs()
})

describe('AgentSessionForkDialog parent reads', () => {
  it('keeps the last good read when the submit-time read fails', async () => {
    mocks.getRuntimeGitStatus.mockResolvedValue(statusWith(DIRTY_ENTRIES))
    await renderDialog()
    expect(carrySwitch()?.getAttribute('aria-checked')).toBe('true')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.getRuntimeGitStatus.mockRejectedValue(new Error('offline'))
    await submitWithEnter()
    warn.mockRestore()

    expect(mocks.runAgentSessionFork).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceHeadOid: HEAD_OID, carryChanges: true }),
      expect.any(Function)
    )
  })

  it('ignores a mount-time read that lands after the submit-time read', async () => {
    let resolveMountRead: (status: GitStatusResult) => void = () => {}
    mocks.getRuntimeGitStatus.mockReturnValueOnce(
      new Promise<GitStatusResult>((resolve) => {
        resolveMountRead = resolve
      })
    )
    const movedHead = 'b'.repeat(40)
    mocks.getRuntimeGitStatus.mockResolvedValue({ ...statusWith(DIRTY_ENTRIES), head: movedHead })
    mocks.runAgentSessionFork.mockResolvedValue({ ok: false, error: 'boom' })
    await renderDialog()
    await submitWithEnter()
    expect(mocks.runAgentSessionFork).toHaveBeenCalledWith(
      expect.objectContaining({ sourceHeadOid: movedHead }),
      expect.any(Function)
    )
    expect(bodyText()).toContain('Bring uncommitted changes (2 modified, 1 new)')

    await act(async () => resolveMountRead(statusWith([])))
    expect(bodyText()).toContain('Bring uncommitted changes (2 modified, 1 new)')
  })
})
