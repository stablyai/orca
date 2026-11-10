// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useComposerState } from '@/hooks/useComposerState'
import { getTaskPageRepoSourceContext } from '@/lib/work-items/task-repo-source-context'
import type { ComposerModalData } from '@/components/new-workspace/composer-modal-data'
import type { Repo } from '../../../../shared/repo-types'
import { COMPOSER_CREATE_HANDOFF_DELAY_MS } from '@/lib/workspace/creation/composer-create-handoff'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { getDefaultSettings } from '../../../../shared/constants'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }))

const repo: Repo = {
  id: 'backlog-repo',
  path: '/backlog-repo',
  displayName: 'Backlog project',
  badgeColor: '',
  addedAt: 0
}
const originalState = useAppStore.getState()
let originalApi: PropertyDescriptor | undefined
const reposUpdate = vi.fn<Window['api']['repos']['update']>()
const worktreesCreate = vi.fn<Window['api']['worktrees']['create']>()

beforeEach(() => {
  vi.clearAllMocks()
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      repos: { update: reposUpdate },
      hooks: {
        check: vi.fn(async () => ({ hasHooks: false, hooks: null, mayNeedUpdate: false }))
      },
      gh: { repoSlug: vi.fn(async () => null) },
      preflight: { detectAgents: vi.fn(async () => ['claude']) },
      sparsePresets: { list: vi.fn(async () => []) },
      worktrees: {
        create: worktreesCreate,
        listRetiredNames: vi.fn(async () => EMPTY_RETIRED_NAME_REGISTRY)
      }
    }
  })
  const projection = projectHostSetupProjectionFromRepos([repo])
  useAppStore.setState({
    settings: getDefaultSettings('/home/backlog-test'),
    repos: [repo],
    projects: [...projection.projects],
    projectHostSetups: [...projection.setups],
    projectGroups: [],
    newWorkspaceDraft: null,
    worktreesByRepo: {},
    sparsePresetsByRepo: {},
    pendingWorktreeCreations: {},
    activePendingCreationId: null,
    activeModal: 'none',
    modalData: {}
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useAppStore.setState(originalState, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('Backlog quick create recovery after the composer hands off', () => {
  it('reopens with the edited draft and resubmits it with the task context', async () => {
    const taskSourceContext = getTaskPageRepoSourceContext(repo, 'backlog')!
    const first = renderHook(() =>
      useComposerState({
        persistDraft: false,
        initialRepoId: repo.id,
        initialName: 'TASK-7 Fix export',
        initialPrompt: 'Original Backlog template',
        initialTaskSourceContext: taskSourceContext
      })
    )
    act(() => first.result.current.cardProps.onAgentPromptChange('Edited Backlog draft'))
    // A slow startup-policy save keeps preparation past the 1.5s handoff, then fails.
    const slowSave = Promise.withResolvers<Repo>()
    reposUpdate.mockReturnValueOnce(slowSave.promise)
    act(() => first.result.current.cardProps.onSetupAgentStartupPolicyChange('wait-for-setup'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const submit = first.result.current.submitQuick('claude')
    await act(() => vi.advanceTimersByTimeAsync(COMPOSER_CREATE_HANDOFF_DELAY_MS))
    expect(Object.keys(useAppStore.getState().pendingWorktreeCreations)).toHaveLength(1)
    slowSave.reject(new Error('repo update failed'))
    await act(() => submit)
    vi.useRealTimers()

    const reopen = toastError.mock.calls.find(([, options]) => options?.action)?.[1].action
    expect(reopen.label).toBe('Reopen')
    expect(useAppStore.getState().pendingWorktreeCreations).toEqual({})
    first.unmount()
    act(() => reopen.onClick())
    const reopened = useAppStore.getState().modalData as ComposerModalData
    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(reopened).toMatchObject({
      backlogTaskPrompt: 'Edited Backlog draft',
      taskSourceContext
    })

    reposUpdate.mockImplementation(async () => ({
      ...repo,
      hookSettings: {
        mode: 'auto',
        setupAgentStartupPolicy: 'wait-for-setup',
        scripts: { setup: '', archive: '' }
      }
    }))
    worktreesCreate.mockReturnValue(new Promise(() => {}))
    const second = renderHook(() =>
      useComposerState({
        persistDraft: false,
        initialRepoId: reopened.initialRepoId,
        initialName: reopened.prefilledName,
        initialPrompt: reopened.backlogTaskPrompt,
        initialTaskSourceContext: reopened.taskSourceContext
      })
    )
    await act(() => second.result.current.submitQuick('claude'))
    await waitFor(() => expect(worktreesCreate).toHaveBeenCalledOnce())
    const created = worktreesCreate.mock.calls[0]?.[0]
    expect(created).toMatchObject({
      repoId: repo.id,
      createdWithAgent: 'claude',
      linkedTaskSourceContext: taskSourceContext
    })
    // The host-spawned agent receives the edited draft as unsent input, not the original template.
    expect(created?.startup?.command).toContain('--prefill')
    expect(created?.startup?.command).toContain('Edited Backlog draft')
    expect(created?.startup?.command).not.toContain('Original Backlog template')
  })
})
