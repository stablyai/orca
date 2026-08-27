// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useFolderSubmitOrchestration,
  type FolderSubmitOrchestrationInput
} from './folder-submit-orchestration'

const mocks = vi.hoisted(() => ({
  syncKanbanTaskAfterWorkspaceStart: vi.fn(),
  submitFolderWorkspaceCreate: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/kanban-workspace-start-sync', () => ({
  syncKanbanTaskAfterWorkspaceStart: mocks.syncKanbanTaskAfterWorkspaceStart
}))
vi.mock('@/components/sidebar/folder-workspace-composer-submit', () => ({
  resolveFolderWorkspaceLaunchDraft: () => null,
  submitFolderWorkspaceCreate: mocks.submitFolderWorkspaceCreate
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const kanbanLinkedItem = {
  provider: 'kanban',
  type: 'issue',
  number: 0,
  title: 'K-1 Fix login',
  url: 'https://kanban.fpimi.ru/?task=K-1',
  kanbanIdentifier: 'K-1'
} as const

function makeState(
  overrides: Partial<FolderSubmitOrchestrationInput>
): FolderSubmitOrchestrationInput {
  return {
    clearNewWorkspaceDraft: vi.fn(),
    createFolderWorkspace: vi.fn(),
    decisions: {
      canResolveFolderSmartGitHubSubmit: () => false
    },
    disabledTuiAgents: [],
    folderCreateDisabled: false,
    folderSourceRepos: [],
    folderTargetConnectionId: null,
    folderTargetIsRemote: false,
    folderTargetRuntimeEnvironmentId: null,
    isSubmissionCancelled: () => false,
    lastAutoNameRef: { current: '' },
    linkedWorkItem: kanbanLinkedItem,
    name: 'Folder name',
    note: '',
    onCreated: vi.fn(),
    persistDraft: false,
    resolvePendingSmartGitHubSubmit: vi.fn().mockResolvedValue({ kind: 'none' }),
    selectedProjectGroup: { id: 'group-1', parentPath: '/work' } as never,
    setCreateError: vi.fn(),
    setCreating: vi.fn(),
    settings: {},
    taskSourceContext: null,
    telemetrySource: 'sidebar',
    ...overrides
  } as unknown as FolderSubmitOrchestrationInput
}

beforeEach(() => {
  mocks.syncKanbanTaskAfterWorkspaceStart.mockReset()
  mocks.submitFolderWorkspaceCreate.mockReset()
  mocks.toastError.mockReset()
})

describe('useFolderSubmitOrchestration kanban sync', () => {
  it('syncs the Kanban card after a successful folder workspace creation with branch null', async () => {
    mocks.submitFolderWorkspaceCreate.mockResolvedValue(true)
    const onCreated = vi.fn()
    const state = makeState({ onCreated })
    const hook = renderHook(() => useFolderSubmitOrchestration(state))

    let submission!: Promise<void>
    act(() => {
      submission = hook.result.current.submitFolderTarget(null)
    })
    await act(async () => submission)

    expect(mocks.syncKanbanTaskAfterWorkspaceStart).toHaveBeenCalledWith({
      linkedWorkItem: expect.objectContaining({ provider: 'kanban', kanbanIdentifier: 'K-1' }),
      projectName: 'Folder name',
      branch: null
    })
  })

  it('does not sync the Kanban card when folder workspace creation fails', async () => {
    mocks.submitFolderWorkspaceCreate.mockResolvedValue(false)
    const state = makeState({})
    const hook = renderHook(() => useFolderSubmitOrchestration(state))

    let submission!: Promise<void>
    act(() => {
      submission = hook.result.current.submitFolderTarget(null)
    })
    await act(async () => submission)

    expect(mocks.syncKanbanTaskAfterWorkspaceStart).not.toHaveBeenCalled()
  })
})