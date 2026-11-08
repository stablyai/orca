// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  source,
  useRoutingFixture
} from './task-page-linear-refresh-test-fixtures'
import { reads as issueReadRegistry } from '@/store/slices/linear/linear-issue-read-lifecycle'
import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { useLinearIssueCreationForm } from './use-task-page-linear-creation-state'
import { useTaskPageLinearIssueCreation } from './use-task-page-linear-issue-creation'

import { useTaskPageJiraCreationStatePrelude } from '../jira/use-task-page-jira-creation-state'

import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import { useAppStore } from '@/store'

import { writeLinearIssue } from '@/lib/work-items/linear/linear-issue-write'
import {
  getProviderRuntimeContextKey,
  bumpProviderRuntimeSessionGeneration
} from '@/lib/provider-runtime-context'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear/linear-slice-test-harness'

function useCreateFixture(
  context: ReturnType<typeof source>,
  initial: LinearIssue | null = null,
  initialTitle = 'Created',
  initialOpen = true,
  runtime = { current: 'runtime' }
) {
  const draft = useAppStore.getState().newLinearIssueDraft
  const noop = vi.fn()
  const form = useLinearIssueCreationForm(runtime.current, {
    open: initialOpen,
    title: draft?.title ?? initialTitle,
    body: draft?.body ?? (initialTitle ? 'Body' : '')
  })
  const route = useRoutingFixture(context, initial)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
  const creation = useTaskPageLinearIssueCreation({
    ...route,
    settings: null,
    providerRuntimeContextKey: runtime.current,
    providerRuntimeContextKeyRef: runtime,
    linearTaskSourceContext: context,
    setLinearRefreshNonce: noop,
    selectedLinearProject: null,
    ...form,
    newLinearIssueTargetTeam: { id: 'team-1', workspaceId: 'w' }
  } as never)
  return {
    ...creation,
    submitting: form.newLinearIssueSubmitting,
    title: form.newLinearIssueTitle,
    body: form.newLinearIssueBody,
    open: form.newLinearIssueOpen
  }
}

it('create selects N before pending A settles, without waiting for N follow-up hydration', async () => {
  const s = store(),
    context = source('local')
  s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
  const pending = deferred<{ ok: boolean }>(),
    held = deferred<LinearIssue | null>()
  const created = {
    ...task('Created N'),
    id: 'N',
    identifier: 'ENG-2',
    title: 'Created title',
    priority: 2
  }
  reads.create.mockResolvedValue({ ok: true, id: 'N', identifier: 'ENG-2' })
  reads.detail.mockImplementation((_context, id) =>
    id === 'N' && reads.detail.mock.calls.filter((call) => call[1] === 'N').length === 1
      ? Promise.resolve(created)
      : held.promise
  )
  const hook = renderHook(() => {
    const creation = useCreateFixture(context, task())
    const detail = useLinearIssueWorkspaceDetail({
      issue: creation.selectedLinearIssue ?? task(),
      providerSettings: context,
      requestKey: creation.selectedLinearIssue?.id ?? 'A'
    })
    return { ...creation, detail }
  })
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(task(), { priority: 4 }, context, () => pending.promise)
  })
  await act(async () => {
    await hook.result.current.handleCreateNewLinearIssue()
  })
  await waitFor(() => expect(hook.result.current.selectedLinearIssue?.id).toBe('N'))
  expect(hook.result.current.detail.displayed).toMatchObject({
    id: 'N',
    title: 'Created title',
    priority: 2,
    workspaceId: 'w'
  })
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(hook.result.current.detail.displayed).toMatchObject({
    id: 'N',
    title: 'Created title',
    priority: 2,
    workspaceId: 'w'
  })
  expect(hook.result.current.detail.editState.priority).toBe(2)
  expect(hook.result.current.detail.issueLoading).toBe(true)
  hook.unmount()
  held.resolve(null)
  await held.promise
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
})

it('actual runtime replacement and new create outlive old success and own finally without revival', async () => {
  const s = store(),
    context = source('local'),
    runtime = { current: getProviderRuntimeContextKey(null) }
  s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
  const old = deferred<{ ok: boolean; id: string; identifier: string }>(),
    next = deferred<{ ok: boolean; id: string; identifier: string }>()
  reads.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const hook = renderHook(() => {
    const model = useCreateFixture(context, null, 'Old', true, runtime)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actual runtime reset prelude uses these Linear fields; unrelated Jira/metadata services are inert.
    useTaskPageJiraCreationStatePrelude({
      ...model,
      setNewLinearIssueTeamId: vi.fn(),
      setNewLinearIssueProjects: vi.fn(),
      setNewLinearIssueProjectsLoading: vi.fn()
    } as never)
    return model
  })
  let a!: Promise<void>, b!: Promise<void>
  act(() => {
    a = hook.result.current.handleCreateNewLinearIssue()
  })
  act(() => {
    bumpProviderRuntimeSessionGeneration()
    runtime.current = getProviderRuntimeContextKey(null)
    hook.rerender()
  })
  expect(hook.result.current.submitting).toBe(false)
  act(() => {
    hook.result.current.setNewLinearIssueTitle('Replacement')
    hook.result.current.setNewLinearIssueBody('New body')
    hook.result.current.setNewLinearIssueOpen(true)
  })
  act(() => {
    b = hook.result.current.handleCreateNewLinearIssue()
  })
  expect(hook.result.current.submitting).toBe(true)
  await act(async () => {
    old.resolve({ ok: true, id: 'Old', identifier: 'W-1' })
    await a
  })
  expect(hook.result.current).toMatchObject({
    title: 'Replacement',
    body: 'New body',
    open: true,
    submitting: true
  })
  expect(reads.detail).not.toHaveBeenCalled()
  await act(async () => {
    next.resolve({ ok: false, id: 'New', identifier: 'W-2' })
    await b
  })
  expect(hook.result.current.submitting).toBe(false)
  act(() => hook.result.current.setNewLinearIssueOpen(false))
  expect(s.getState().newLinearIssueDraft).toEqual({ title: 'Replacement', body: 'New body' })
  hook.unmount()
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
  act(() => s.getState().patchLinearIssue('Old', { priority: 4 }, { sourceContext: context }))
  expect(reads.detail).not.toHaveBeenCalled()
})
