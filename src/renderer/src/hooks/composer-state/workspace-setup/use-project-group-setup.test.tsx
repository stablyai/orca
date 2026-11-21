// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createProjectGroup } from '../../../../../shared/project/groups/project-groups'
import { getDefaultRepoHookSettings } from '../../../../../shared/workspace-setup/repo-hook-settings-defaults'
import '../../../components/settings/__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store/index'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { useProjectGroupSetup } from './use-project-group-setup'
import '../submission/folder-submit-orchestration'
import '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit'
import 'sonner'

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
