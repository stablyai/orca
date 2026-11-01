// @vitest-environment happy-dom
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  structured: vi.fn(async () => true),
  findStructured: vi.fn((): object | null => null),
  activateAndRevealWorkspace: vi.fn<(workspaceId: string) => unknown>(),
  toastError: vi.fn<(message: string) => void>(),
  folderWorkspaces: new Array<{ id: string; projectGroupId: string; executionHostId: string }>()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.structured
}))
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
  findStructuredAgentSessionTab: mocks.findStructured
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => {
  const state = {
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    get folderWorkspaces() {
      return mocks.folderWorkspaces
    }
  }
  return {
    useAppStore: Object.assign((select: (s: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})

import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'

function folder(executionHostId: string) {
  return { id: 'folder-1', projectGroupId: 'group-1', executionHostId }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.folderWorkspaces = []
  mocks.findStructured.mockReturnValue(null)
  mocks.structured.mockResolvedValue(true)
})

afterEach(() => cleanup())

describe('jumpToWorktree', () => {
  it('activates folder workspaces through the workspace activator', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
    const { result } = renderHook(() => useAiVaultOriginalPaneActions())
    result.current.jumpToWorktree('folder:folder-1')
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('leaves a refused folder to the toast folder activation already showed', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    mocks.folderWorkspaces = [folder('local')]
    const { result } = renderHook(() => useAiVaultOriginalPaneActions())
    result.current.jumpToWorktree('folder:folder-1')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    ['folder:gone', []],
    ['repo-1::/repo/gone', []],
    // The same folder id on two hosts: activation cannot pick one and returns before any toast.
    ['folder:folder-1', [folder('local'), folder('runtime:env-2')]]
  ])('reports a workspace that is gone or has no single owner (%s)', (id, folders) => {
    mocks.folderWorkspaces = folders
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    const { result } = renderHook(() => useAiVaultOriginalPaneActions())
    result.current.jumpToWorktree(id)
    expect(mocks.toastError).toHaveBeenCalledWith(
      id.startsWith('folder:')
        ? 'Folder workspace is no longer available.'
        : 'Worktree is no longer available.'
    )
  })
})

it('keeps the original-pane handled boolean used by the History dialog close callback', async () => {
  const session: AiVaultSession = {
    id: 'history-chat',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'provider-1',
    title: 'Saved Chat',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/fixture/session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    structuredSession: { workspaceId: 'workspace', sessionId: 'claude_saved' }
  }
  mocks.findStructured.mockReturnValue({})
  mocks.structured.mockResolvedValue(true)
  const { result } = renderHook(() => useAiVaultOriginalPaneActions())
  expect(await result.current.jumpToOriginalPane(session)).toBe(true)
  expect(mocks.structured).toHaveBeenCalledWith(session)
  expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
})
