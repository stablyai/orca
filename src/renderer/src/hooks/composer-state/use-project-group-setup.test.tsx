// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createProjectGroup } from '../../../../shared/project-groups'
import { getDefaultRepoHookSettings } from '../../../../shared/constants'
import '../../components/settings/__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { useProjectGroupSetup } from './use-project-group-setup'
import { useFolderSubmitOrchestration } from './folder-submit-orchestration'
import { submitFolderWorkspaceCreate } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit'
import { toast } from 'sonner'

vi.mock('@/lib/workspace/creation/setup/folder-setup-support', () => ({
  useFolderSetupSupport: () => 'supported',
  resolveFolderSetupSupported: async () => true
}))
vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({ checkRuntimeGroupHooks: vi.fn() }))
vi.mock('@/lib/workspace/creation/setup/workspace-setup-trust', () => ({
  confirmWorkspaceSetupDecision: async () => ({ setupDecision: 'skip' })
}))
vi.mock('@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit', () => ({
  submitFolderWorkspaceCreate: vi.fn(async () => true)
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const group = {
  ...createProjectGroup({
    name: 'Services',
    parentPath: '/services',
    createdFrom: 'folder-scan',
    tabOrder: 0
  }),
  id: 'services'
}
const saved = {
  ...getDefaultRepoHookSettings(),
  scripts: { setup: 'echo retained', archive: '' },
  setupAgentStartupPolicy: 'start-immediately' as const
}
const inspected = {
  status: 'ok' as const,
  hasHooks: false,
  hooks: null,
  hookSettings: saved,
  mayNeedUpdate: false,
  setupRunPolicy: 'run-by-default' as const,
  setupConfig: null
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkRuntimeGroupHooks).mockResolvedValue(inspected)
})

function useSubmission(selected: typeof group) {
  const groupSetup = useProjectGroupSetup(selected)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the folder submission path runs; unrelated composer fields are not read.
  const submit = useFolderSubmitOrchestration({
    groupSetup,
    selectedProjectGroup: selected,
    folderCreateDisabled: false,
    folderSourceRepos: [],
    disabledTuiAgents: [],
    isSubmissionCancelled: () => false,
    decisions: { canResolveFolderSmartGitHubSubmit: () => false },
    setCreateError: vi.fn(),
    setCreating: vi.fn(),
    revealSetupChoice: vi.fn(),
    lastAutoNameRef: { current: '' },
    name: 'task',
    note: '',
    linkedWorkItem: null,
    settings: null,
    folderTargetRuntimeEnvironmentId: null,
    folderTargetIsRemote: false,
    createFolderWorkspace: vi.fn(),
    onCreated: vi.fn(),
    taskSourceContext: null,
    resolvePendingSmartGitHubSubmit: vi.fn(),
    telemetrySource: 'sidebar',
    clearNewWorkspaceDraft: vi.fn(),
    persistDraft: false
  } as unknown as Parameters<typeof useFolderSubmitOrchestration>[0])
  return { groupSetup, ...submit }
}

it.each([true, false])(
  'settles a held policy save before group inspection/create (save=%s)',
  async (success) => {
    let finish!: (saved: boolean) => void
    const updateProjectGroup = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    useAppStore.setState({ projectGroups: [group], updateProjectGroup })
    const hook = renderHook(() => {
      return useSubmission(group)
    })
    await waitFor(() => expect(hook.result.current.groupSetup.shouldWaitForSetupCheck).toBe(false))
    await waitFor(() => expect(checkRuntimeGroupHooks).toHaveBeenCalledOnce())
    await act(async () => {
      hook.result.current.groupSetup.setStartupPolicy('wait-for-setup')
    })
    await waitFor(() => expect(updateProjectGroup).toHaveBeenCalledOnce())
    let submitting!: Promise<void>
    act(() => {
      submitting = hook.result.current.submitFolderTarget(null)
    })
    await Promise.resolve()
    expect(submitFolderWorkspaceCreate).not.toHaveBeenCalled()
    expect(checkRuntimeGroupHooks).toHaveBeenCalledOnce()
    await act(async () => {
      finish(success)
      await submitting
    })
    if (success) {
      expect(submitFolderWorkspaceCreate).toHaveBeenCalledOnce()
      expect(toast.error).not.toHaveBeenCalled()
    } else {
      expect(submitFolderWorkspaceCreate).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledOnce()
      expect(hook.result.current.groupSetup.startupPolicy).toBe('start-immediately')
    }
    hook.unmount()
  }
)

it('does not roll an old owner failure over a newer owner policy selection', async () => {
  const second = { ...group, id: 'second', parentPath: '/second' }
  let finishFirst!: (value: boolean) => void
  let finishSecond!: (value: boolean) => void
  const updateProjectGroup = vi.fn(
    (groupId: string) =>
      new Promise<boolean>((resolve) => {
        if (groupId === group.id) {
          finishFirst = resolve
        } else {
          finishSecond = resolve
        }
      })
  )
  useAppStore.setState({ projectGroups: [group, second], updateProjectGroup })
  const hook = renderHook(({ selected }) => useProjectGroupSetup(selected), {
    initialProps: { selected: group }
  })
  await waitFor(() => expect(hook.result.current.shouldWaitForSetupCheck).toBe(false))
  await act(async () => {
    hook.result.current.setStartupPolicy('wait-for-setup')
  })
  let oldSettlement!: Promise<boolean>
  act(() => {
    oldSettlement = hook.result.current.waitForStartupPolicySave()
  })
  hook.rerender({ selected: second })
  await waitFor(() => expect(hook.result.current.shouldWaitForSetupCheck).toBe(false))
  await act(async () => {
    hook.result.current.setStartupPolicy('wait-for-setup')
  })
  await act(async () => {
    finishFirst(false)
    expect(await oldSettlement).toBe(false)
  })
  expect(hook.result.current.startupPolicy).toBe('wait-for-setup')
  await act(async () => {
    finishSecond(true)
    expect(await hook.result.current.waitForStartupPolicySave()).toBe(true)
  })
  expect(hook.result.current.startupPolicy).toBe('wait-for-setup')
  hook.unmount()
})

it.each([true, false])(
  'retains a held owner save across A→B(save)→A (save=%s)',
  async (success) => {
    const second = { ...group, id: 'second', parentPath: '/second' }
    let finishFirst!: (value: boolean) => void
    const updateProjectGroup = vi.fn((groupId: string) =>
      groupId === group.id
        ? new Promise<boolean>((resolve) => {
            finishFirst = resolve
          })
        : Promise.resolve(true)
    )
    useAppStore.setState({ projectGroups: [group, second], updateProjectGroup })
    const hook = renderHook(({ selected }) => useSubmission(selected), {
      initialProps: { selected: group }
    })
    await waitFor(() => expect(hook.result.current.groupSetup.shouldWaitForSetupCheck).toBe(false))
    await act(async () => {
      hook.result.current.groupSetup.setStartupPolicy('wait-for-setup')
    })
    hook.rerender({ selected: second })
    await waitFor(() => expect(hook.result.current.groupSetup.shouldWaitForSetupCheck).toBe(false))
    await act(async () => {
      hook.result.current.groupSetup.setStartupPolicy('wait-for-setup')
      expect(await hook.result.current.groupSetup.waitForStartupPolicySave()).toBe(true)
    })
    hook.rerender({ selected: group })
    await waitFor(() => expect(hook.result.current.groupSetup.shouldWaitForSetupCheck).toBe(false))
    const inspectionsBeforeSubmit = vi.mocked(checkRuntimeGroupHooks).mock.calls.length
    let submitting!: Promise<void>
    act(() => {
      submitting = hook.result.current.submitFolderTarget(null)
    })
    await Promise.resolve()
    expect(submitFolderWorkspaceCreate).not.toHaveBeenCalled()
    expect(checkRuntimeGroupHooks).toHaveBeenCalledTimes(inspectionsBeforeSubmit)
    await act(async () => {
      finishFirst(success)
      await submitting
    })
    if (success) {
      expect(submitFolderWorkspaceCreate).toHaveBeenCalledOnce()
      expect(toast.error).not.toHaveBeenCalled()
    } else {
      expect(submitFolderWorkspaceCreate).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledOnce()
    }
    hook.unmount()
  }
)
