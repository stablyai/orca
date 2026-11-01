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
import { useTaskPageLinearCustomViewEffects } from './use-task-page-linear-custom-view-effects'
import { useTaskPageSourceAvailabilityPrelude } from '../use-task-page-source-availability'
import { useTaskPageJiraCreationStatePrelude } from '../jira/use-task-page-jira-creation-state'
import { TaskPageLinearFilters } from './Filters'
import { TaskPageLinearIssueDialog } from './IssueDialog'
import { TooltipProvider } from '../../ui/tooltip'
import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import {
  getProviderRuntimeContextKey,
  bumpProviderRuntimeSessionGeneration
} from '@/lib/provider-runtime-context'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { expect, it, vi } from 'vitest'
import { act, renderHook, waitFor, render, screen, fireEvent } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear-slice-test-harness'
import { Suspense, startTransition, useState, useLayoutEffect, type ComponentProps } from 'react'

type LinearDialogModel = ComponentProps<typeof TaskPageLinearIssueDialog>['model']

it.each([
  { suspend: true, change: 'source' },
  { suspend: false, change: 'source' },
  { suspend: true, change: 'selection' },
  { suspend: false, change: 'selection' },
  { suspend: false, change: 'source', successor: 'closed' },
  { suspend: false, change: 'source', successor: 'reopened' },
  { suspend: false, change: 'selection', successor: 'editback' },
  { suspend: false, change: 'source', successor: 'none', outcome: 'success' },
  { suspend: false, change: 'source', successor: 'none', outcome: 'false' },
  { suspend: false, change: 'source', successor: 'none', outcome: 'throw' }
])(
  'pending create $change suspend=$suspend successor=$successor outcome=$outcome',
  async ({ suspend, change, successor = 'open', outcome = 'success' }) => {
    const s = store()
    s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
    const A = source('local'),
      B = { ...A, accountLabel: 'B' }
    const realWorkspaceSwitch = change === 'source' && !suspend
    if (realWorkspaceSwitch) {
      s.setState({
        linearStatus: {
          ...s.getState().linearStatus,
          activeWorkspaceId: 'w',
          workspaces: ['w', 'h'].map((id) => ({
            id,
            organizationId: id,
            organizationName: id,
            displayName: 'User',
            email: null
          }))
        }
      })
    }
    const selecting = deferred<ReturnType<typeof s.getState>['linearStatus']>()
    reads.select.mockReturnValue(selecting.promise)
    const creating = deferred<{ ok: boolean; id: string; identifier: string }>()
    const hydration = deferred<LinearIssue | null>()
    const blocked = deferred<void>()
    let reject!: (error: Error) => void
    reads.create.mockReturnValue(
      outcome === 'throw'
        ? new Promise((_resolve, fail) => {
            reject = fail
          })
        : creating.promise
    )
    reads.detail.mockReturnValue(hydration.promise)
    const seen: string[] = [],
      committed: string[] = []
    let navigate!: (value: boolean) => void
    let create!: () => Promise<void>
    let currentForm!: ReturnType<typeof useCreateFixture>
    function Consumer({ b }: { b: boolean }) {
      const status = useAppStore((state) => state.linearStatus)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real source prelude consumes these account-backed inputs; repo/provider services are inert.
      const workspaceSource = useTaskPageSourceAvailabilityPrelude({
        settings: null,
        providerRuntimeContextKey: 'runtime',
        selectedRepos: [],
        selectedLinearWorkspaceId: status.selectedWorkspaceId,
        selectedLinearWorkspace:
          status.workspaces?.find((workspace) => workspace.id === status.selectedWorkspaceId) ??
          null,
        selectedJiraSiteId: null,
        selectedJiraSite: null,
        taskSource: 'linear',
        taskSourceRepoContexts: [],
        hostRegistryById: new Map()
      } as never).linearTaskSourceContext!
      const context = realWorkspaceSwitch ? workspaceSource : b && change === 'source' ? B : A
      const model = useCreateFixture(
        context,
        null,
        realWorkspaceSwitch ? '' : 'Created',
        !realWorkspaceSwitch
      )
      const isB = realWorkspaceSwitch
        ? status.selectedWorkspaceId === 'h'
        : change === 'source'
          ? b
          : model.selectedLinearIssue?.id === 'selected-B'
      const dialogModel = {
        ...model,
        newLinearIssueOpen: model.open,
        newLinearIssueTitle: model.title,
        newLinearIssueBody: model.body,
        newLinearIssueSubmitting: model.submitting,
        availableTeams: [
          { id: 'team-1', workspaceId: 'w', name: 'Team 1', key: 'T1' },
          { id: 'team-2', workspaceId: 'w', name: 'Team 2', key: 'T2' }
        ],
        linearMode: 'issues',
        linearModeOptions: [],
        linearSearchInput: '',
        submitShortcutLabel: 'Ctrl+Enter',
        newLinearIssueProjects: [],
        newLinearStates: { data: [], loading: false, error: null },
        newLinearMembers: { data: [], loading: false, error: null },
        newLinearLabels: { data: [], loading: false, error: null },
        setNewLinearIssueTeamId: vi.fn(),
        handleCreateNewJiraIssue: vi
          .fn<LinearDialogModel['handleCreateNewJiraIssue']>()
          .mockResolvedValue(undefined),
        newJiraIssueSummaryAvailable: false,
        newJiraIssueSummaryGenerating: false,
        newJiraIssueSummaryError: null,
        handleGenerateNewJiraIssueSummary: vi
          .fn<LinearDialogModel['handleGenerateNewJiraIssueSummary']>()
          .mockResolvedValue(undefined),
        handleNewJiraIssueTitleChange: vi.fn<LinearDialogModel['handleNewJiraIssueTitleChange']>(),
        handleCancelNewJiraIssueSummaryGeneration:
          vi.fn<LinearDialogModel['handleCancelNewJiraIssueSummaryGeneration']>(),
        githubTasksBusy: false,
        openComposerForLinearItem: vi.fn<LinearDialogModel['openComposerForLinearItem']>(),
        handleUseLinearItem: vi.fn<LinearDialogModel['handleUseLinearItem']>(),
        handleOpenOrUseLinearItem: vi.fn<LinearDialogModel['handleOpenOrUseLinearItem']>(),
        handleLinearWorkspaceChange: vi.fn<LinearDialogModel['handleLinearWorkspaceChange']>(),
        handleLinearTeamSelectionChange:
          vi.fn<LinearDialogModel['handleLinearTeamSelectionChange']>(),
        handleLinearScopeOpen: vi.fn<LinearDialogModel['handleLinearScopeOpen']>(),
        handleLinearAccessConnected: vi.fn<LinearDialogModel['handleLinearAccessConnected']>(),
        openComposerForJiraItem: vi.fn<LinearDialogModel['openComposerForJiraItem']>(),
        handleUseJiraItem: vi.fn<LinearDialogModel['handleUseJiraItem']>(),
        taskPageListChromeHidden: false
      } satisfies LinearDialogModel
      useLayoutEffect(() => {
        create = model.handleCreateNewLinearIssue
        currentForm = model
        committed.push(isB ? 'B' : 'A')
        if (change === 'selection') {
          navigate = () => model.setSelectedLinearIssue({ ...task('Selected B'), id: 'selected-B' })
        }
      })
      seen.push(isB ? 'B' : 'A')
      if (isB && suspend) {
        throw blocked.promise
      }
      return (
        <>
          <output data-testid="creation-scope">
            {isB ? 'B' : 'A'}:{model.selectedLinearIssue?.state.name ?? 'none'}:
            {String(model.submitting)}
          </output>
          {!suspend && (
            <TooltipProvider>
              <TaskPageLinearFilters model={dialogModel} />
              <TaskPageLinearIssueDialog model={dialogModel} />
            </TooltipProvider>
          )}
        </>
      )
    }
    function Harness() {
      const [b, setB] = useState(false)
      if (change === 'source') {
        navigate = setB
      }
      return (
        <Suspense fallback={<span>Blocked</span>}>
          <Consumer b={b} />
        </Suspense>
      )
    }
    const mounted = render(<Harness />)
    let selection!: Promise<void>
    if (realWorkspaceSwitch) {
      act(() => {
        currentForm.clearSelectedLinearIssue()
        selection = s.getState().selectLinearWorkspace('h')
      })
      expect(s.getState().linearStatus.selectedWorkspaceId).toBe('w')
      fireEvent.click(screen.getByRole('button', { name: 'New Linear issue' }))
      fireEvent.change(screen.getByPlaceholderText('Issue title'), { target: { value: 'Created' } })
      fireEvent.change(screen.getByPlaceholderText('Add description...'), {
        target: { value: 'Body' }
      })
    }
    let saving!: Promise<void>
    act(() => {
      saving = create()
    })
    if (realWorkspaceSwitch) {
      expect(screen.getByPlaceholderText('Issue title')).toHaveProperty('disabled', true)
      expect(reads.create).toHaveBeenCalledWith(
        expect.objectContaining({
          providerIdentity: expect.objectContaining({ workspaceId: 'w' })
        }),
        expect.objectContaining({ title: 'Created', workspaceId: 'w' })
      )
      await act(async () => {
        selecting.resolve({
          ...s.getState().linearStatus,
          selectedWorkspaceId: 'h',
          activeWorkspaceId: 'h'
        })
        await selection
      })
      expect(reads.select).toHaveBeenCalledTimes(1)
      expect(s.getState().linearStatus.selectedWorkspaceId).toBe('h')
      expect(screen.getByPlaceholderText('Issue title')).toHaveProperty('disabled', true)
      expect(screen.getByPlaceholderText('Add description...')).toHaveProperty('disabled', true)
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true)
      const dialog = screen.getByRole('dialog')
      const x = dialog.querySelector('button:has(svg.lucide-x)')!
      expect(x).toHaveProperty('disabled', true)
      fireEvent.click(x)
      fireEvent.keyDown(dialog, { key: 'Escape' })
      fireEvent.keyDown(screen.getByPlaceholderText('Issue title'), { key: 'Enter' })
      expect(currentForm.open).toBe(true)
      expect(screen.getByRole('button', { name: 'Select Team' })).toHaveProperty('disabled', false)
      await act(async () => {
        await create()
      })
      expect(reads.create).toHaveBeenCalledTimes(1)
    } else {
      await act(async () => {
        startTransition(() => navigate(true))
      })
    }
    expect(seen).toContain('B')
    expect(committed.includes('B')).toBe(!suspend)
    const expected =
      successor === 'editback' || successor === 'reopened'
        ? { title: 'Created', body: 'Body' }
        : { title: 'Successor', body: 'Successor body' }
    if (!suspend && successor !== 'none') {
      // Controlled successor setters are a separate contract from disabled DOM admission.
      act(() => {
        currentForm.setNewLinearIssueTitle('Successor')
        currentForm.setNewLinearIssueBody('Successor body')
      })
      if (successor === 'editback' || successor === 'reopened') {
        act(() => {
          currentForm.setNewLinearIssueTitle('Created')
          currentForm.setNewLinearIssueBody('Body')
        })
      }
      if (successor === 'closed' || successor === 'reopened') {
        act(() => currentForm.setNewLinearIssueOpen(false))
        if (successor === 'reopened') {
          fireEvent.click(screen.getByRole('button', { name: 'New Linear issue' }))
          act(() => currentForm.setNewLinearIssueOpen(false))
        }
      }
    } else if (!suspend) {
      // Same-value setters and picker-only renders must not supersede submitted D.
      const captured = currentForm.captureNewLinearIssueDraft()
      act(() => {
        currentForm.setNewLinearIssueTitle((v) => v)
        currentForm.setNewLinearIssueBody((v) => v)
        currentForm.setNewLinearIssuePriority(3)
      })
      expect(currentForm.captureNewLinearIssueDraft()).toBe(captured)
    }
    await act(async () => {
      if (outcome === 'throw') {
        const rejected = expect(saving).rejects.toThrow('create rejected')
        reject(new Error('create rejected'))
        await rejected
      } else {
        creating.resolve({
          ok: outcome === 'success',
          id: task().id,
          identifier: task().identifier
        })
        await saving
      }
    })
    await act(async () => {
      hydration.resolve(task('Created External'))
      await hydration.promise
    })
    if (suspend && change === 'source') {
      await act(async () => {
        navigate(false)
      })
    }
    const visible = screen.getByTestId('creation-scope').textContent
    try {
      if (!suspend && successor !== 'none') {
        expect(currentForm).toMatchObject({
          ...expected,
          open: successor !== 'closed' && successor !== 'reopened'
        })
      }
      expect(visible).toBe(
        suspend
          ? 'A:Created External:false'
          : change === 'source'
            ? 'B:none:false'
            : 'B:Selected B:false'
      )
      if (!suspend) {
        expect(reads.create).toHaveBeenCalledTimes(1)
        expect(reads.detail).not.toHaveBeenCalled()
        if (successor === 'none' && outcome === 'success') {
          expect(currentForm).toMatchObject({
            open: false,
            title: '',
            body: '',
            submitting: false,
            newLinearIssuePriority: 0
          })
          expect(s.getState().newLinearIssueDraft).toBeNull()
          fireEvent.click(screen.getByRole('button', { name: 'New Linear issue' }))
          expect(screen.getByPlaceholderText('Issue title')).toHaveProperty('value', '')
        } else {
          if (currentForm.open) {
            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
          }
          const retained = successor === 'none' ? { title: 'Created', body: 'Body' } : expected
          expect(s.getState().newLinearIssueDraft).toEqual(retained)
          fireEvent.click(screen.getByRole('button', { name: 'New Linear issue' }))
          expect(screen.getByPlaceholderText('Issue title')).toHaveProperty('value', retained.title)
          expect(screen.getByPlaceholderText('Add description...')).toHaveProperty(
            'value',
            retained.body
          )
          if (outcome !== 'success') {
            fireEvent.change(screen.getByPlaceholderText('Issue title'), {
              target: { value: 'Retry current' }
            })
            reads.create.mockResolvedValueOnce({ ok: false })
            await act(async () => {
              await create()
            })
            expect(reads.create).toHaveBeenCalledTimes(2)
            expect(reads.create).toHaveBeenLastCalledWith(
              expect.anything(),
              expect.objectContaining({ title: 'Retry current', workspaceId: 'w' })
            )
            expect(currentForm.submitting).toBe(false)
          }
        }
      }
    } finally {
      mounted.unmount()
      expect(pendingLinearIssueWrites.size).toBe(0)
      expect(issueReadRegistry.size).toBe(0)
    }
  }
)

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

it.each([
  { unmount: false, outcome: 'success' },
  { unmount: true, outcome: 'success' },
  { unmount: true, outcome: 'false' },
  { unmount: true, outcome: 'throw' },
  { unmount: true, outcome: 'success', switched: true }
])(
  'create held over unmount=$unmount outcome=$outcome switched=$switched completes the session draft without orphan demand',
  async ({ unmount, outcome, switched = false }) => {
    const ok = outcome === 'success'
    const s = store(),
      context = source('local')
    s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
    const creating = deferred<{ ok: boolean; id: string; identifier: string }>()
    reads.create.mockReturnValue(creating.promise)
    reads.detail.mockResolvedValue({ ...task('Created'), id: 'N' })
    let reject!: (error: Error) => void
    if (outcome === 'throw') {
      reads.create.mockReturnValue(
        new Promise((_resolve, fail) => {
          reject = fail
        })
      )
    }
    const success = vi.spyOn(toast, 'success')
    const hook = renderHook(() => useCreateFixture(context))
    let saving!: Promise<void>
    act(() => {
      saving = hook.result.current.handleCreateNewLinearIssue()
    })
    if (unmount) {
      hook.unmount()
      expect(s.getState().newLinearIssueDraft).toEqual({ title: 'Created', body: 'Body' })
    }
    if (switched) {
      bumpProviderRuntimeSessionGeneration()
      s.getState().setNewLinearIssueDraft({ title: 'Other runtime', body: 'New draft' })
    }
    await act(async () => {
      if (outcome === 'throw') {
        const rejection = expect(saving).rejects.toThrow('create rejected')
        reject(new Error('create rejected'))
        await rejection
      } else {
        creating.resolve({ ok, id: 'N', identifier: 'ENG-2' })
        await saving
      }
    })
    expect(reads.create).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledTimes(ok && !switched ? 1 : 0)
    expect(s.getState().newLinearIssueDraft).toEqual(
      switched
        ? { title: 'Other runtime', body: 'New draft' }
        : ok
          ? null
          : { title: 'Created', body: 'Body' }
    )
    expect(reads.detail).toHaveBeenCalledTimes(unmount ? 0 : 1)
    if (!unmount) {
      await waitFor(() => expect(hook.result.current.selectedLinearIssue?.id).toBe('N'))
      expect(hook.result.current).toMatchObject({
        submitting: false,
        open: false,
        title: '',
        body: ''
      })
      hook.unmount()
    }
    expect(pendingLinearIssueWrites.size).toBe(0)
    expect(issueReadRegistry.size).toBe(0)
    const reopened = renderHook(() => useCreateFixture(context, null, ''))
    expect(reopened.result.current.title).toBe(switched ? 'Other runtime' : ok ? '' : 'Created')
    expect(reopened.result.current.body).toBe(switched ? 'New draft' : ok ? '' : 'Body')
    reopened.unmount()
    act(() => s.getState().patchLinearIssue('N', { priority: 4 }, { sourceContext: context }))
    expect(reads.detail).toHaveBeenCalledTimes(unmount ? 0 : 1)
  }
)

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

it('an empty-list selection clear preserves a pending create and its successful selection', async () => {
  const s = store(),
    context = source('local')
  s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
  const creating = deferred<{ ok: boolean; id: string; identifier: string }>()
  reads.create.mockReturnValue(creating.promise)
  reads.detail.mockResolvedValue({ ...task('Created'), id: 'N' })
  const hook = renderHook(() => {
    const model = useCreateFixture(context)
    const [emptyRows, setEmptyRows] = useState<LinearIssue[]>([])
    const [connected, setConnected] = useState(true)
    const noop = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only existing selection effect inputs execute; catalog effects are disabled/inert.
    useTaskPageLinearCustomViewEffects({
      ...model,
      taskResumeApplied: true,
      taskSource: 'linear',
      linearMode: 'issues',
      linearConnected: connected,
      selectedLinearCustomView: null,
      linearCustomViewIssueResult: { read: noop, setLoading: noop },
      setLinearCustomViewIssuesResult: noop,
      setLinearCustomViewProjectsResult: noop,
      filteredLinearIssues: emptyRows
    } as never)
    return { ...model, deliver: () => setEmptyRows([]), setConnected }
  })
  let saving!: Promise<void>
  try {
    act(() => {
      saving = hook.result.current.handleCreateNewLinearIssue()
    })
    expect(hook.result.current.submitting).toBe(true)
    const request = hook.result.current.linearSelectionRequest
    act(() => hook.result.current.deliver())
    expect(hook.result.current.linearSelectionRequest).toBe(request)
    act(() => hook.result.current.setConnected(false))
    expect(hook.result.current.linearSelectionRequest).toBe(request)
    expect(hook.result.current.submitting).toBe(true)
    act(() => hook.result.current.setConnected(true))
    expect(reads.create).toHaveBeenCalledTimes(1)
    await act(async () => {
      creating.resolve({ ok: true, id: 'N', identifier: 'ENG-2' })
      await saving
    })
    await waitFor(() => expect(hook.result.current.selectedLinearIssue?.id).toBe('N'))
    expect(hook.result.current.submitting).toBe(false)
    expect(reads.detail).toHaveBeenCalledTimes(1)
    act(() => hook.result.current.deliver())
    expect(hook.result.current.selectedLinearIssue?.id).toBe('N')
    act(() => hook.result.current.setSelectedLinearIssue(task()))
    expect(hook.result.current.selectedLinearIssue).toBeNull()
    act(() => hook.result.current.setSelectedLinearIssue(task(), { allowOutsideList: true }))
    expect(hook.result.current.selectedLinearIssue?.id).toBe(task().id)
    act(() => hook.result.current.setConnected(false))
    expect(hook.result.current.selectedLinearIssue).toBeNull()
  } finally {
    hook.unmount()
    creating.resolve({ ok: true, id: 'N', identifier: 'ENG-2' })
    await saving
    expect(pendingLinearIssueWrites.size).toBe(0)
    expect(issueReadRegistry.size).toBe(0)
    act(() => s.getState().patchLinearIssue('N', { priority: 4 }, { sourceContext: context }))
    expect(reads.detail).toHaveBeenCalledTimes(1)
  }
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
