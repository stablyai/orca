// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({ submitFolderWorkspaceCreate: vi.fn(async () => true) }))

vi.mock('@/components/sidebar/folder-workspace-composer-submit', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, submitFolderWorkspaceCreate: mocks.submitFolderWorkspaceCreate }
})

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  useFolderSubmitOrchestration,
  type FolderSubmitOrchestrationInput
} from './folder-submit-orchestration'

const structuredSettings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
} as GlobalSettings

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/repo/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeInput(): FolderSubmitOrchestrationInput {
  return {
    clearNewWorkspaceDraft: vi.fn(),
    createFolderWorkspace: vi.fn(async () => null),
    // Only the folder smart-GitHub gate is reached from this hook; the rest stay unexercised.
    decisions: {
      canResolveFolderSmartGitHubSubmit: () => false,
      getInitialAutoManagedWorkspaceName: vi.fn(),
      getInitialGitHubPrStartPointSelection: vi.fn(),
      getMatchingLinkedTaskSourceContext: vi.fn(),
      isExplicitWorkspaceNameInput: vi.fn(),
      resolveInitialWorkspaceRunSeed: vi.fn(),
      resolveSmartGitHubCreateNames: vi.fn(),
      retargetGitHubPrStartPointSelection: vi.fn()
    },
    disabledTuiAgents: [],
    folderCreateDisabled: false,
    folderSourceRepos: [],
    folderTargetConnectionId: null,
    folderTargetIsRemote: false,
    folderTargetRuntimeEnvironmentId: null,
    isSubmissionCancelled: () => false,
    lastAutoNameRef: { current: '' },
    linkedWorkItem: null,
    name: 'hi',
    note: '',
    onCreated: vi.fn(),
    persistDraft: false,
    resolvePendingSmartGitHubSubmit: vi.fn(async () => ({ kind: 'none' }) as const),
    selectedProjectGroup: makeProjectGroup(),
    setCreateError: vi.fn(),
    setCreating: vi.fn(),
    settings: structuredSettings,
    taskSourceContext: null,
    telemetrySource: undefined
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('useFolderSubmitOrchestration capability probe', () => {
  afterEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
    Reflect.deleteProperty(window, 'api')
    vi.clearAllMocks()
  })

  // submitFolderWorkspaceCreate runs straight through to createFolderWorkspace with no suspension
  // of its own, so the probe has to settle on this side of the cancel gate.
  it('does not create when the composer is dismissed while the probe is still pending', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const status = deferred<{ capabilities: readonly string[] }>()
    const getStatus = vi.fn(() => status.promise)
    Object.assign(window, { api: { runtime: { getStatus } } })
    let cancelled = false
    const hook = renderHook(() =>
      useFolderSubmitOrchestration({ ...makeInput(), isSubmissionCancelled: () => cancelled })
    )

    let submission!: Promise<void>
    act(() => {
      submission = hook.result.current.submitFolderTarget('claude')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getStatus).toHaveBeenCalledTimes(1)

    cancelled = true
    status.resolve({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
    await act(async () => submission)

    expect(mocks.submitFolderWorkspaceCreate).not.toHaveBeenCalled()
  })

  it('hands the resolved capabilities to the create path instead of letting it re-probe', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi
      .fn()
      .mockResolvedValue({ capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
    Object.assign(window, { api: { runtime: { getStatus } } })

    const hook = renderHook(() => useFolderSubmitOrchestration(makeInput()))
    await act(async () => hook.result.current.submitFolderTarget('claude'))

    expect(mocks.submitFolderWorkspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      })
    )
  })
})
