// @vitest-environment happy-dom
import {
  queued,
  detailTransport,
  events,
  mocks,
  actual,
  repo,
  onSelect,
  pickerStore,
  resetPickerStore,
  LinearPicker,
  prepareDefaultPicker,
  installRuntimeBridge,
  aliasStatus,
  aliasRow
} from './smart-workspace-linear-read-test-fixtures'
import { LinearIntegrationCard } from '../../src/renderer/src/components/settings/task-tracker-integration-cards'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { getIssue } from '../../src/main/linear/linear-issue-lookups'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLinearRequestMaps } from '@/store/slices/linear/linear-slice-request-state'
import {
  buildTaskSourceContextFromRepo,
  getTaskSourceCacheScope
} from '../../src/shared/task-source-context'
import { linearSearchCacheKey } from '@/store/slices/linear/linear-cache'
import { RESULT_LIMIT } from '../../src/renderer/src/components/new-workspace/smart-workspace-name-field-model'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { credentialDecryptionMessage } from '../../src/shared/integration-credential-errors'
import type { LinearIssue } from '../../src/shared/linear/issue-types'
import type { LinearConnectionStatus } from '../../src/shared/linear/workspace-types'
import { referenceLinearIssue } from '../../src/renderer/src/components/sidebar/workspace-reference-fixtures.test-support'

vi.mock('../../src/renderer/src/components/settings/linear-agent-skill-install-cta', () => ({
  LinearAgentSkillInstallCta: () => null
}))
vi.mock('../../src/renderer/src/components/linear-api-key-dialog', () => ({
  LinearApiKeyDialog: () => null
}))

describe('composer Linear read errors', () => {
  beforeEach(() => {
    mocks.state.linearStatus = {
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'workspace-1'
    }
    clearLinearRequestMaps()
    resetPickerStore()
    const { searchLinearIssues: _search, getCachedLinearIssues: _cache, ...initial } = mocks.state
    pickerStore.setState(initial)
    onSelect.mockClear()
    mocks.state.searchLinearIssues.mockReset()
    mocks.state.getCachedLinearIssues.mockReset()
    mocks.state.getCachedLinearIssues.mockReturnValue(null)
  })
  afterEach(() => {
    cleanup()
    clearLinearRequestMaps()
  })

  it.each([
    { cache: 'cold', attachment: false },
    { cache: 'warm', attachment: false },
    { cache: 'cold', attachment: true },
    { cache: 'warm', attachment: true }
  ])(
    '$cache network failure is safe with attachment=$attachment and successful retry clears it',
    async ({ cache, attachment }) => {
      if (cache === 'warm') {
        const context = buildTaskSourceContextFromRepo({
          provider: 'linear',
          projectId: repo.id,
          repo
        })!
        const key = `${getTaskSourceCacheScope(context)}::${linearSearchCacheKey('workspace-1', 'launch', RESULT_LIMIT)}`
        pickerStore.setState({
          linearSearchCache: { [key]: { data: [referenceLinearIssue()], fetchedAt: 1 } }
        })
      }
      mocks.state.searchLinearIssues.mockRejectedValue(new Error('private network diagnostic'))
      const { rerender } = render(<LinearPicker value="launch" attachment={attachment} />)
      fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
      const message = 'Unable to load Linear issues. Try again.'
      await waitFor(() => expect(screen.getAllByText(message)).toHaveLength(1))
      expect(screen.queryByText('Reconnect Linear')).toBeNull()
      if (cache === 'warm') {
        fireEvent.click(screen.getByText(/Task/))
        expect(onSelect).toHaveBeenCalledTimes(1)
      }
      fireEvent.click(screen.getByRole('button', { name: 'Smart tab' }))
      expect(screen.queryByText(message)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
      mocks.state.searchLinearIssues.mockResolvedValue([referenceLinearIssue()])
      rerender(<LinearPicker value="recovered" attachment={attachment} />)
      await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
      await waitFor(() => expect(screen.queryByText(message)).toBeNull())
    }
  )

  it('shows the read credential error on the Linear tab only, and a successful search clears it', async () => {
    mocks.state.searchLinearIssues.mockImplementation(async (query) => {
      if (query === 'broken') {
        throw new Error(credentialDecryptionMessage('Linear'))
      }
      return [referenceLinearIssue()]
    })
    const message = 'Reconnect Linear'
    const { rerender } = render(<LinearPicker value="broken" />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        `${message}Unable to read saved Linear login. Reconnect it in Settings.`
      )
    )

    // The status refresh after the failure re-runs the same read; the error must stay up.
    mocks.state.linearStatus = {
      ...mocks.state.linearStatus,
      credentialError: credentialDecryptionMessage('Linear')
    }
    rerender(<LinearPicker value="broken" />)
    expect(screen.getByText(message)).toBeTruthy()
    await waitFor(() => expect(mocks.state.searchLinearIssues).toHaveBeenCalled())
    expect(screen.getByText(message)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Smart tab' }))
    expect(screen.queryByText(message)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))

    rerender(<LinearPicker value="launch" />)
    await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
    expect(screen.queryByText(message)).toBeNull()
  })
})

it.each(
  ['list', 'search'].flatMap((kind) =>
    ['success', 'error', 'queued'].map((outcome) => ({ kind, outcome }))
  )
)(
  'runtime refresh retires default New Workspace $kind pre-event $outcome',
  async ({ kind, outcome }) => {
    prepareDefaultPicker({ connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' })
    cleanup()
    queued.enabled = false
    queued.updates.length = 0
    const old = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    const fresh = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    const runtime = kind === 'search' ? mocks.state.searchLinearIssues : mocks.state.list
    const data = (title: string) => {
      const items = [{ ...referenceLinearIssue(), title }]
      return kind === 'search' ? items : { items }
    }
    runtime.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const control = Promise.withResolvers<LinearIssue | null>()
    mocks.state.detail.mockReset()
    mocks.state.detail.mockImplementation((context) =>
      context.kind === 'task-source' || context.environmentId === 'other'
        ? control.promise
        : Promise.resolve(referenceLinearIssue())
    )
    const explicit = buildTaskSourceContextFromRepo({
      provider: 'linear',
      projectId: repo.id,
      repo
    })!
    const controls = [
      getLinearSourceScope(explicit),
      getLinearSourceScope({ ...explicit, accountLabel: 'Other full source' }),
      getLinearSourceScope({ kind: 'environment', environmentId: 'other' })
    ].map((scope) =>
      pickerStore.getState().fetchLinearIssue('ISSUE-1', 'workspace-1', { scope }).acquire()
    )
    expect(mocks.state.detail).toHaveBeenCalledTimes(3)
    installRuntimeBridge()
    const mounted = render(<LinearPicker value={kind === 'search' ? 'launch' : ''} defaultSource />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
    await waitFor(() => expect(runtime).toHaveBeenCalledTimes(1))
    const joined = Array.from({ length: 5 }, () =>
      kind === 'search'
        ? pickerStore.getState().searchLinearIssues('launch', RESULT_LIMIT).acquire()
        : pickerStore
            .getState()
            .listLinearIssues({ kind: 'list', filter: 'assigned', limit: RESULT_LIMIT })
            .acquire()
    )
    expect(runtime).toHaveBeenCalledTimes(1)
    queued.enabled = true
    if (outcome === 'queued') {
      await act(async () => {
        old.resolve(data('Pre-event'))
        await old.promise
      })
    }
    const beforeEdge = queued.updates.splice(0)
    act(() =>
      events.emit({
        type: 'linearLinkedIssueUpdated',
        worktreeId: 'fixture-worktree',
        identifier: 'ISSUE-1',
        workspaceId: 'workspace-1'
      })
    )
    const replacementUpdates = queued.updates.splice(0)
    queued.enabled = false
    expect(runtime).toHaveBeenCalledTimes(2)
    expect(mocks.state.detail).toHaveBeenCalledTimes(4)
    act(() => beforeEdge.forEach((update) => update()))
    expect(screen.queryByText('Pre-event')).toBeNull()
    act(() => replacementUpdates.forEach((update) => update()))
    if (outcome !== 'queued') {
      await act(async () => {
        if (outcome === 'success') {
          old.resolve(data('Pre-event'))
        } else {
          old.reject(new Error('old private diagnostic'))
        }
        await old.promise.catch(() => {})
      })
      expect(screen.queryByText('Pre-event')).toBeNull()
    }
    await act(async () => {
      fresh.reject(new Error('private diagnostic'))
      await fresh.promise.catch(() => {})
    })
    await waitFor(() =>
      expect(screen.getAllByText('Unable to load Linear issues. Try again.')).toHaveLength(1)
    )
    expect(runtime).toHaveBeenCalledTimes(2)
    const forced = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    const external = Promise.withResolvers<LinearIssue[] | { items: LinearIssue[] }>()
    runtime.mockReturnValueOnce(forced.promise).mockReturnValueOnce(external.promise)
    const force = () =>
      kind === 'search'
        ? pickerStore
            .getState()
            .searchLinearIssues('launch', RESULT_LIMIT, { force: true })
            .acquire()
        : pickerStore
            .getState()
            .listLinearIssues(
              { kind: 'list', filter: 'assigned', limit: RESULT_LIMIT },
              { force: true }
            )
            .acquire()
    let A!: ReturnType<typeof force>, B!: ReturnType<typeof force>
    act(() => {
      A = force()
      B = force()
    })
    expect(runtime).toHaveBeenCalledTimes(4)
    await act(async () => {
      forced.resolve(data('Superseded force'))
      external.resolve(data('External'))
      await external.promise
    })
    await waitFor(() => expect(screen.getByText(/External/)).toBeTruthy())
    expect(screen.queryByText(/Superseded force/)).toBeNull()
    expect(screen.queryByText('Unable to load Linear issues. Try again.')).toBeNull()
    A.release()
    B.release()
    control.resolve(referenceLinearIssue())
    await Promise.all(controls.map((lease) => lease.waitForCurrentTerminal()))
    expect(controls.every((lease) => lease.currentView().kind === 'data')).toBe(true)
    controls.forEach((lease) => lease.release())
    mounted.unmount()
    joined.forEach((lease) => lease.release())
    act(() =>
      events.emit({
        type: 'linearLinkedIssueUpdated',
        worktreeId: 'fixture-worktree',
        identifier: 'ISSUE-1',
        workspaceId: 'workspace-1'
      })
    )
    expect(runtime).toHaveBeenCalledTimes(4)
    cleanup()
    clearLinearRequestMaps()
  }
)

it('attachment Retry reacquires terminal cached missing without another provider read', async () => {
  resetPickerStore()
  const status: LinearConnectionStatus = {
    connected: true,
    viewer: null,
    selectedWorkspaceId: 'L',
    workspaces: [
      {
        displayName: 'Test',
        email: null,
        id: 'L',
        organizationId: 'org',
        organizationName: 'Acme',
        organizationUrlKey: 'acme'
      }
    ]
  }
  mocks.state.linearStatus = status
  pickerStore.setState({
    linearStatus: status,
    linearStatusChecked: true,
    linearStatusContextKey: 'local#0',
    preflightStatusChecked: true,
    preflightStatusContextKey: 'test',
    refreshPreflightStatus: vi.fn()
  })
  mocks.state.detail.mockReset().mockResolvedValue(null)
  function Attachment() {
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0)
    return (
      <LinearPicker
        key={attempt}
        value="https://linear.app/acme/issue/ENG-1/missing"
        defaultSource
        attachment
        onRetry={retry}
      />
    )
  }
  render(<Attachment />)
  const missing = 'Couldn’t load this Linear issue. Check the URL and connected workspace.'
  await waitFor(() => expect(screen.getByText(missing)).toBeTruthy())
  expect(mocks.state.detail).toHaveBeenCalledTimes(1)
  expect(pickerStore.getState().linearIssueCache['L::ENG-1']?.data).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.getByText(missing)).toBeTruthy())
  expect(screen.queryByText('Loading Linear issue…')).toBeNull()
  expect(mocks.state.detail).toHaveBeenCalledTimes(1)
})

it.each(['success', 'error', 'queued'])(
  'runtime event retires a held same-literal URL alias observation: %s',
  async (outcome) => {
    const status = aliasStatus()
    const row = aliasRow
    prepareDefaultPicker(status)
    const old = Promise.withResolvers<LinearIssue | null>()
    const fresh = Promise.withResolvers<LinearIssue | null>()
    const control = Promise.withResolvers<LinearIssue | null>()
    let aliasLoads = 0
    mocks.state.detail.mockReset().mockImplementation((context, _id, workspaceId) => {
      if (
        context.kind === 'task-source' ||
        context.environmentId === 'other' ||
        workspaceId === 'F'
      ) {
        return control.promise
      }
      if (workspaceId === 'L') {
        return ++aliasLoads === 1 ? old.promise : fresh.promise
      }
      return Promise.resolve(row('Exact W', 'W'))
    })
    pickerStore.setState({
      linearIssueCache: { 'L::ENG-1': { data: row('Warm'), fetchedAt: 1 } }
    })
    const explicit = buildTaskSourceContextFromRepo({
      provider: 'linear',
      projectId: repo.id,
      repo
    })!
    const controls = [
      pickerStore
        .getState()
        .fetchLinearIssue('ENG-1', 'F', { seed: { ...row('Foreign', 'F'), id: 'other-U' } })
        .acquire(),
      pickerStore
        .getState()
        .fetchLinearIssue('ENG-1', 'L', {
          scope: getLinearSourceScope(explicit),
          seed: row('Explicit')
        })
        .acquire(),
      pickerStore
        .getState()
        .fetchLinearIssue('ENG-1', 'L', {
          scope: getLinearSourceScope({ kind: 'environment', environmentId: 'other' }),
          seed: row('Other runtime')
        })
        .acquire()
    ]
    const controlViews = controls.map((lease) => lease.currentView())
    installRuntimeBridge()
    const mounted = render(
      <LinearPicker value="https://linear.app/acme/issue/ENG-1/task" defaultSource />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
    await waitFor(() => expect(aliasLoads).toBe(1))
    queued.enabled = true
    if (outcome === 'queued') {
      await act(async () => {
        old.resolve(row('Pre-event'))
        await old.promise
      })
    }
    const oldUpdates = queued.updates.splice(0)
    const emit = () =>
      events.emit({
        type: 'linearLinkedIssueUpdated',
        worktreeId: 'fixture-worktree',
        identifier: 'ENG-1',
        workspaceId: 'W'
      })
    act(emit)
    const currentUpdates = queued.updates.splice(0)
    queued.enabled = false
    expect(aliasLoads).toBe(2)
    expect(
      mocks.state.detail.mock.calls.filter(([, , workspaceId]) => workspaceId === 'W')
    ).toHaveLength(1)
    expect(controls.map((lease) => lease.currentView())).toEqual(controlViews)
    act(() => oldUpdates.forEach((update) => update()))
    expect(screen.queryByText(/Pre-event/)).toBeNull()
    act(() => currentUpdates.forEach((update) => update()))
    if (outcome !== 'queued') {
      await act(async () => {
        if (outcome === 'success') {
          old.resolve(row('Pre-event'))
        } else {
          old.reject(new Error('retired private diagnostic'))
        }
        await old.promise.catch(() => {})
      })
    }
    if (outcome === 'queued') {
      await act(async () => {
        fresh.reject(new Error('current private diagnostic'))
        await fresh.promise.catch(() => {})
      })
      await waitFor(() =>
        expect(screen.getAllByText('Unable to load Linear issues. Try again.')).toHaveLength(1)
      )
    } else {
      expect(screen.queryByText(/Pre-event/)).toBeNull()
      await act(async () => {
        fresh.resolve(row('External'))
        await fresh.promise
      })
      await waitFor(() => expect(screen.getByText(/External/)).toBeTruthy())
      expect(screen.queryByText(/Pre-event/)).toBeNull()
    }
    expect(
      mocks.state.detail.mock.calls.filter(([, , workspaceId]) => workspaceId === 'W')
    ).toHaveLength(1)
    expect(aliasLoads).toBe(2)
    control.resolve(row('Control'))
    await Promise.all(controls.map((lease) => lease.waitForCurrentTerminal()))
    controls.forEach((lease) => lease.release())
    mounted.unmount()
    act(emit)
    expect(aliasLoads).toBe(2)
  }
)

it.each(['success', 'fallback', 'legacy', 'release'] as const)(
  'cold URL alias actual provider replacement: %s',
  async (outcome) => {
    const status = aliasStatus(outcome === 'legacy')
    prepareDefaultPicker(status)
    expect(pickerStore.getState().linearIssueCache).toEqual({})
    const old = Promise.withResolvers<LinearIssue | null>()
    const fresh = Promise.withResolvers<LinearIssue | null>()
    const control = Promise.withResolvers<LinearIssue | null>()
    let aliasLoads = 0
    detailTransport.issue.mockReset().mockImplementation(async (_id, workspaceId) => {
      const issue =
        workspaceId === 'L'
          ? await (++aliasLoads === 1 ? old.promise : fresh.promise)
          : aliasRow('Exact W', 'W')
      if (!issue) {
        throw new Error('missing issue')
      }
      // Only SDK I/O is synthetic; actual main concurrency/mapping/detail settlement runs.
      return { ...issue, updatedAt: new Date(issue.updatedAt), labelIds: [] }
    })
    detailTransport.rpc.mockReset().mockImplementation((target, method, params) => {
      expect(target).toEqual({ kind: 'environment', environmentId: 'env-1' })
      expect(method).toBe('linear.getIssue')
      return getIssue(params.id, params.workspaceId)
    })
    mocks.state.detail.mockReset().mockImplementation((context, id, workspaceId) => {
      if (
        context.kind === 'task-source' ||
        context.environmentId === 'other' ||
        workspaceId === 'F' ||
        id === 'ENG-2'
      ) {
        return control.promise
      }
      return actual.linearGetIssue(context, id, workspaceId)
    })
    const explicit = buildTaskSourceContextFromRepo({
      provider: 'linear',
      projectId: repo.id,
      repo
    })!
    const controls =
      outcome === 'success'
        ? [
            pickerStore.getState().fetchLinearIssue('ENG-2', 'L').acquire(),
            pickerStore.getState().fetchLinearIssue('ENG-1', 'F').acquire(),
            pickerStore
              .getState()
              .fetchLinearIssue('ENG-1', 'L', {
                scope: getLinearSourceScope(explicit)
              })
              .acquire(),
            pickerStore
              .getState()
              .fetchLinearIssue('ENG-1', 'L', {
                scope: getLinearSourceScope({ kind: 'environment', environmentId: 'other' })
              })
              .acquire()
          ]
        : []
    const controlViews = controls.map((lease) => lease.currentView())
    expect(controlViews.every((view) => view.kind === 'loading' && view.data === null)).toBe(true)
    installRuntimeBridge()
    const mounted = render(
      <LinearPicker value="https://linear.app/acme/issue/ENG-1/task" defaultSource attachment />
    )
    const emit = () =>
      events.emit({
        type: 'linearLinkedIssueUpdated',
        worktreeId: 'fixture-worktree',
        identifier: 'ENG-1',
        workspaceId: 'W'
      })
    const loads = (workspaceId: string) =>
      detailTransport.issue.mock.calls.filter(([, workspace]) => workspace === workspaceId).length
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
      await waitFor(() => expect(loads('L')).toBe(1))
      expect(screen.getByText('Loading Linear issue…')).toBeTruthy()
      act(emit)
      await waitFor(() => expect(loads('L')).toBe(2))
      await waitFor(() => expect(loads('W')).toBe(1))
      expect(controls.map((lease) => lease.currentView())).toEqual(controlViews)
      expect(mocks.state.detail).toHaveBeenCalledTimes(controls.length + 3)
      if (outcome === 'release') {
        mounted.unmount()
      }
      await act(async () => {
        if (outcome === 'fallback') {
          old.reject(new Error('retired provider diagnostic'))
        } else {
          old.resolve(aliasRow('Pre-event In Review'))
        }
        await old.promise.catch(() => {})
      })
      expect(screen.queryByText(/Pre-event/)).toBeNull()
      expect(screen.queryByText(/Exact W/)).toBeNull()
      if (outcome !== 'release') {
        expect(screen.getByText('Loading Linear issue…')).toBeTruthy()
        expect(screen.queryByText(/Couldn’t load this Linear issue/)).toBeNull()
      }
      await act(async () => {
        if (outcome === 'fallback') {
          // The existing status probe supplies a newly discovered URL candidate W.
          mocks.state.linearStatus = { ...status, workspaces: status.workspaces!.toReversed() }
          fresh.reject(new Error('current provider diagnostic'))
        } else {
          fresh.resolve(aliasRow('Current External'))
        }
        await fresh.promise.catch(() => {})
      })
      if (outcome !== 'release') {
        await waitFor(() =>
          expect(
            screen.getByText(outcome === 'fallback' ? /Exact W/ : /Current External/)
          ).toBeTruthy()
        )
        expect(screen.queryByText('Loading Linear issue…')).toBeNull()
        expect(screen.queryByText(/Couldn’t load this Linear issue/)).toBeNull()
        expect(screen.queryByText(/provider diagnostic|Pre-event/)).toBeNull()
      }
      expect(loads('L')).toBe(2)
      expect(loads('W')).toBe(1)
      expect(controls.map((lease) => lease.currentView())).toEqual(controlViews)
      expect(mocks.state.detail).toHaveBeenCalledTimes(controls.length + 3)
      controls.forEach((lease) => lease.release())
      mounted.unmount()
      act(emit)
      await waitFor(() => expect(loads('W')).toBe(2))
      expect(loads('L')).toBe(2)
      expect(mocks.state.detail).toHaveBeenCalledTimes(controls.length + 4)
    } finally {
      mounted.unmount()
      controls.forEach((lease) => lease.release())
      await act(async () => {
        old.resolve(aliasRow('Cleanup'))
        fresh.resolve(aliasRow('Cleanup'))
        control.resolve(aliasRow('Control'))
        await Promise.allSettled([old.promise, fresh.promise, control.promise])
      })
    }
  }
)

it.each([false, true])(
  'warm default launch/12 keeps Task and one error with status outage=%s',
  async (outage) => {
    prepareDefaultPicker({ connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' })
    mocks.state.searchLinearIssues.mockReset().mockResolvedValue([referenceLinearIssue()])
    render(<LinearPicker value="launch" defaultSource />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
    await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
    if (outage) {
      mocks.statusReads.mockRejectedValue(new Error('remote status transport unavailable'))
    }
    mocks.state.searchLinearIssues.mockRejectedValue(
      new Error('remote search transport unavailable')
    )
    const read = pickerStore
      .getState()
      .searchLinearIssues('launch', 12, { force: true, workspaceId: 'workspace-1' })
      .acquire()
    await act(async () => {
      await read.waitForCurrentTerminal()
    })
    expect(pickerStore.getState().linearStatus.connected).toBe(true)
    expect(screen.getByText(/Task/)).toBeTruthy()
    expect(screen.getAllByText('Unable to load Linear issues. Try again.')).toHaveLength(1)
    expect(mocks.statusReads).not.toHaveBeenCalled()
    read.release()
  }
)

it('Settings keeps the confirmed account during failed checks, then displays actual disconnected status', async () => {
  prepareDefaultPicker({ connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' })
  render(
    <TooltipProvider>
      <LinearIntegrationCard />
    </TooltipProvider>
  )
  expect(screen.getByText('Connected')).toBeTruthy()
  mocks.statusReads.mockRejectedValue(new Error('status transport unavailable'))
  await act(async () => {
    await pickerStore.getState().checkLinearConnection(true)
  })
  expect(screen.getByText('Connected')).toBeTruthy()
  expect(screen.queryByText('Not connected')).toBeNull()
  mocks.statusReads.mockResolvedValue({ connected: false, viewer: null })
  await act(async () => {
    await pickerStore.getState().checkLinearConnection(true)
  })
  expect(screen.getByText('Not connected')).toBeTruthy()
})

it('a cold default host cannot import the previously focused host account or rows', async () => {
  prepareDefaultPicker({ connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' })
  mocks.state.searchLinearIssues.mockReset().mockResolvedValue([referenceLinearIssue()])
  render(<LinearPicker value="launch" defaultSource />)
  fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
  await waitFor(() => expect(screen.getByText(/Task/)).toBeTruthy())
  mocks.statusReads.mockRejectedValue(new Error('new host unavailable'))
  const settings = pickerStore.getState().settings
  if (!settings) {
    throw new Error('fixture requires captured host settings')
  }
  act(() =>
    pickerStore.setState({ settings: { ...settings, activeRuntimeEnvironmentId: 'other' } })
  )
  expect(screen.queryByText(/Task/)).toBeNull()
  await waitFor(() => expect(pickerStore.getState().linearStatusContextKey).toBe('runtime:other#0'))
  expect(pickerStore.getState().linearStatusObserved).toBe(false)
  expect(pickerStore.getState().linearStatusChecked).toBe(true)
})
