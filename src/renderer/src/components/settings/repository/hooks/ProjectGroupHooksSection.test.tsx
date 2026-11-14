// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '../../__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store'
import { createProjectGroup } from '../../../../../../shared/project-groups'
import { ProjectGroupHooksSection } from './ProjectGroupHooksSection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import type { GroupHookCheckResult } from '../../../../../../shared/project-group-hooks'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/lib/workspace/creation/setup/folder-setup-support', () => ({
  useFolderSetupSupport: () => 'supported'
}))
vi.mock('@/components/sidebar/workspace-creation/folder/folder-workspace-agent-startup', () => ({
  getFolderWorkspaceAgentLaunchFact: () => ({ kind: 'known', platform: 'darwin' })
}))
vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({ checkRuntimeGroupHooks: vi.fn() }))

const confirmed = {
  mode: 'auto' as const,
  commandSourcePolicy: 'local-only' as const,
  setupRunPolicy: 'run-by-default' as const,
  scripts: { setup: 'echo confirmed', archive: '' },
  setupAgentStartupPolicy: 'start-immediately' as const
}
const inspected: GroupHookCheckResult = {
  status: 'ok',
  hasHooks: false,
  hooks: null,
  mayNeedUpdate: false,
  setupRunPolicy: 'run-by-default',
  setupConfig: null,
  hookSettings: confirmed
}
function saveTestGroup() {
  return {
    ...createProjectGroup({
      name: 'Save',
      parentPath: '/save',
      createdFrom: 'folder-scan',
      tabOrder: 0
    }),
    id: 'save',
    executionHostId: 'local' as const
  }
}
function renderSaveGroup(group = saveTestGroup()) {
  useAppStore.setState({ settingsSearchQuery: '', projectGroups: [group], repos: [] })
  return render(
    <TooltipProvider>
      <ProjectGroupHooksSection key={group.executionHostId} group={group} />
    </TooltipProvider>
  )
}

it('reconciles a real store false save, then keeps a later acknowledged script', async () => {
  const group = saveTestGroup()
  let finish!: (value: null) => void
  const update = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve
        })
    )
    .mockImplementationOnce(async ({ updates }) => ({ ...group, ...updates }))
  Object.defineProperty(window.api, 'projectGroups', { configurable: true, value: { update } })
  let reconcile!: (value: GroupHookCheckResult) => void
  vi.mocked(checkRuntimeGroupHooks)
    .mockReset()
    .mockResolvedValueOnce(inspected)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reconcile = resolve
        })
    )
  renderSaveGroup(group)
  const editor = await screen.findByDisplayValue('echo confirmed')
  fireEvent.change(editor, { target: { value: 'echo attempted' } })
  fireEvent.blur(editor)
  await waitFor(() => expect(update).toHaveBeenCalled())
  expect(editor.closest('fieldset')?.disabled).toBe(true)
  await act(async () => {
    finish(null)
  })
  await waitFor(() => expect(screen.getByDisplayValue('echo confirmed')).toBeTruthy())
  expect(editor.closest('fieldset')?.disabled).toBe(true)
  await act(async () => {
    reconcile(inspected)
  })
  await waitFor(() => expect(editor.closest('fieldset')?.disabled).toBe(false))
  fireEvent.change(editor, { target: { value: 'echo acknowledged' } })
  fireEvent.blur(editor)
  await waitFor(() =>
    expect(useAppStore.getState().projectGroups[0].hookSettings?.scripts?.setup).toBe(
      'echo acknowledged'
    )
  )
  await waitFor(() => expect(editor.closest('fieldset')?.disabled).toBe(false))
  expect(screen.getByDisplayValue('echo acknowledged')).toBeTruthy()
})

it('restores a rejected policy and retains confirmed values when reconciliation cannot answer', async () => {
  let reject!: (reason: Error) => void
  const updateProjectGroup = vi.fn(
    () =>
      new Promise<boolean>((_resolve, fail) => {
        reject = fail
      })
  )
  useAppStore.setState({ updateProjectGroup })
  vi.mocked(checkRuntimeGroupHooks)
    .mockReset()
    .mockResolvedValueOnce(inspected)
    .mockRejectedValueOnce(new Error('owner disconnected'))
  renderSaveGroup()
  const editor = await screen.findByDisplayValue('echo confirmed')
  const policy = screen.getByRole('switch')
  fireEvent.click(policy)
  await waitFor(() => expect(updateProjectGroup).toHaveBeenCalled())
  expect(policy.getAttribute('aria-checked')).toBe('true')
  await act(async () => {
    reject(new Error('save failed'))
  })
  await waitFor(() => expect(policy.getAttribute('aria-checked')).toBe('false'))
  expect(screen.getByDisplayValue('echo confirmed')).toBeTruthy()
  expect(editor.closest('fieldset')?.disabled).toBe(true)
})

it('flushes an unmounted owner draft without applying its late failure to the same group on another host', async () => {
  const first = saveTestGroup()
  let finish!: (saved: boolean) => void
  const updateProjectGroup = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
  )
  useAppStore.setState({ updateProjectGroup })
  vi.mocked(checkRuntimeGroupHooks)
    .mockReset()
    .mockResolvedValueOnce(inspected)
    .mockResolvedValueOnce({
      ...inspected,
      hookSettings: { ...confirmed, scripts: { setup: 'echo other host', archive: '' } }
    })
  const view = renderSaveGroup(first)
  fireEvent.change(await screen.findByDisplayValue('echo confirmed'), {
    target: { value: 'echo leaving' }
  })
  const other = { ...first, executionHostId: 'runtime:other' as const }
  useAppStore.setState({ projectGroups: [other] })
  view.rerender(
    <TooltipProvider>
      <ProjectGroupHooksSection key={other.executionHostId} group={other} />
    </TooltipProvider>
  )
  await waitFor(() =>
    expect(updateProjectGroup).toHaveBeenCalledWith(
      'save',
      {
        hookSettings: { ...confirmed, scripts: { setup: 'echo leaving', archive: '' } }
      },
      { hostId: 'local' }
    )
  )
  await screen.findByDisplayValue('echo other host')
  await act(async () => {
    finish(false)
  })
  expect(screen.getByDisplayValue('echo other host')).toBeTruthy()
})

it('settles an accepted blur before a same-turn policy edit without rolling back the newer settings', async () => {
  let first!: (saved: boolean) => void
  let second!: (saved: boolean) => void
  const updateProjectGroup = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          first = resolve
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          second = resolve
        })
    )
  useAppStore.setState({ updateProjectGroup })
  vi.mocked(checkRuntimeGroupHooks).mockReset().mockResolvedValue(inspected)
  renderSaveGroup()
  const editor = await screen.findByDisplayValue('echo confirmed')
  const policy = screen.getByRole('switch')
  act(() => {
    fireEvent.change(editor, { target: { value: 'echo newest' } })
    fireEvent.blur(editor)
    fireEvent.click(policy)
  })
  await waitFor(() => expect(updateProjectGroup).toHaveBeenCalled())
  await act(async () => {
    first(false)
  })
  await waitFor(() =>
    expect(updateProjectGroup).toHaveBeenLastCalledWith(
      'save',
      {
        hookSettings: {
          ...confirmed,
          scripts: { setup: 'echo newest', archive: '' },
          setupAgentStartupPolicy: 'wait-for-setup'
        }
      },
      { hostId: 'local' }
    )
  )
  await act(async () => {
    second(true)
  })
  await waitFor(() => expect(editor.closest('fieldset')?.disabled).toBe(false))
  expect(screen.getByDisplayValue('echo newest')).toBeTruthy()
  expect(policy.getAttribute('aria-checked')).toBe('true')
})
