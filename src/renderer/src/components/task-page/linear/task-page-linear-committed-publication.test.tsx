// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  source,
  deferredIssueSetters,
  useRoutingFixture
} from './task-page-linear-refresh-test-fixtures'
import { reads as issueReadRegistry } from '@/store/slices/linear/linear-issue-read-lifecycle'
import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear-slice-test-harness'

import { Suspense, startTransition, useState, useLayoutEffect } from 'react'
import { useLinearIssuePublication } from '@/hooks/useLinearIssuePublication'
import type { useTaskPageDetailRouting } from '../use-task-page-detail-routing'

it.each([true, false])(
  'publication speculative B (suspend=%s) preserves committed authority',
  async (suspend) => {
    store()
    const A = source('local'),
      B = { ...A, accountLabel: 'B' }
    const blocked = deferred<void>()
    const pending = deferred<{ ok: boolean }>()
    const seen: string[] = [],
      committed: string[] = []
    let navigate!: (value: boolean) => void
    function Consumer({ b }: { b: boolean }) {
      const row = useLinearIssuePublication(task(), b ? B : A).issue!
      seen.push(b ? 'B' : 'A')
      useLayoutEffect(() => {
        committed.push(b ? 'B' : 'A')
      })
      if (b && suspend) {
        throw blocked.promise
      }
      return (
        <output data-testid="publication-scope">
          {b ? 'B' : 'A'}:{row.priority}
        </output>
      )
    }
    function Harness() {
      const [b, setB] = useState(false)
      navigate = setB
      return (
        <Suspense fallback={<span>Blocked</span>}>
          <Consumer b={b} />
        </Suspense>
      )
    }
    const mounted = render(<Harness />)
    await act(async () => {
      startTransition(() => navigate(true))
    })
    expect(seen).toContain('B')
    expect(committed.includes('B')).toBe(!suspend)
    expect(screen.getByTestId('publication-scope').textContent).toBe(suspend ? 'A:0' : 'B:0')
    let saving!: Promise<{ ok: boolean }>
    act(() => {
      saving = writeLinearIssue(task(), { priority: 4 }, A, () => pending.promise)
    })
    if (suspend) {
      await act(async () => {
        navigate(false)
      })
    }
    const visible = screen.getByTestId('publication-scope').textContent
    try {
      expect(visible).toBe(suspend ? 'A:4' : 'B:0')
    } finally {
      mounted.unmount()
      pending.resolve({ ok: false })
      await saving
      expect(pendingLinearIssueWrites.size).toBe(0)
      expect(issueReadRegistry.size).toBe(0)
    }
  }
)

it.each([true, false])(
  'real routing updater discard (suspend=%s) cannot retire a pending field publication',
  async (suspend) => {
    const s = store()
    s.setState({ jiraIssueCache: {}, jiraSearchCache: {} })
    const context = defaultScopeSource(null)
    const pendingPriority = deferred<{ ok: boolean }>(),
      pendingTitle = deferred<{ ok: boolean }>(),
      pendingEarlierTitle = deferred<{ ok: boolean }>()
    const hydrated = deferred<LinearIssue | null>(),
      blocked = deferred<void>()
    reads.detail.mockReturnValue(hydrated.promise)
    let route!: ReturnType<typeof useTaskPageDetailRouting>
    let pulse!: () => void
    const renders: string[] = [],
      commits: string[] = []
    let block = true
    function Consumer() {
      const [tick, setTick] = useState(0)
      const current = useRoutingFixture(null)
      useLayoutEffect(() => {
        route = current
        pulse = () => setTick((n) => n + 1)
        commits.push(
          `${current.selectedLinearIssue?.state.name}:${current.selectedLinearIssue?.priority}`
        )
      })
      renders.push(
        `${current.selectedLinearIssue?.state.name}:${current.selectedLinearIssue?.priority}`
      )
      if (suspend && block && current.selectedLinearIssue?.state.name === 'Hydrated') {
        throw blocked.promise
      }
      return (
        <output data-testid="hydration-scope">
          {current.selectedLinearIssue?.title}:{current.selectedLinearIssue?.priority}:{tick}
        </output>
      )
    }
    const mounted = render(
      <Suspense fallback={<span>Blocked</span>}>
        <Consumer />
      </Suspense>
    )
    act(() => route.setSelectedLinearIssue(task()))
    let lease!: ReturnType<ReturnType<typeof s.getState>['fetchLinearIssue']> extends {
      acquire: () => infer L
    }
      ? L
      : never
    let prioritySaving!: Promise<{ ok: boolean }>,
      titleSaving!: Promise<{ ok: boolean }>,
      earlierTitleSaving!: Promise<{ ok: boolean }>
    await act(async () => {
      startTransition(() => {
        earlierTitleSaving = writeLinearIssue(
          task(),
          { title: 'Earlier title' },
          context,
          () => pendingEarlierTitle.promise
        )
        prioritySaving = writeLinearIssue(
          task(),
          { priority: 4 },
          context,
          () => pendingPriority.promise
        )
        lease = s
          .getState()
          .fetchLinearIssue(task().id, 'w', { force: true, seed: task() })
          .acquire()
      })
      hydrated.resolve(task('Hydrated'))
      await hydrated.promise
      await Promise.resolve()
      await Promise.resolve()
      const view = lease.currentView()
      expect(view.data?.state.name).toBe('Hydrated')
      expect(view.data?.priority).toBe(4)
      startTransition(() =>
        route.setSelectedLinearIssue(view.data, {
          expectedSelection: route.linearSelectionRequest,
          isCurrent: () => lease.commit(view, false, () => true)
        })
      )
    })
    expect(renders).toContain('Hydrated:4')
    expect(commits.includes('Hydrated:4')).toBe(!suspend)
    // A real later field write retires the delivered read but must not erase pending priority.
    act(() => {
      titleSaving = writeLinearIssue(
        task(),
        { title: 'Current title' },
        context,
        () => pendingTitle.promise
      )
      pulse()
    })
    block = false
    await act(async () => {
      pulse()
    })
    const visible = screen.getByTestId('hydration-scope').textContent
    const { projectLinearIssue } = await import('@/store/slices/linear/linear-issue-publication')
    expect(projectLinearIssue(getLinearSourceScope(context), task()).priority).toBe(4)
    try {
      expect(visible).toContain('Current title:4:')
    } finally {
      mounted.unmount()
      lease.release()
      pendingTitle.resolve({ ok: false })
      pendingPriority.resolve({ ok: false })
      pendingEarlierTitle.resolve({ ok: false })
      await Promise.all([prioritySaving, titleSaving, earlierTitleSaving])
      expect(pendingLinearIssueWrites.size).toBe(0)
      expect(issueReadRegistry.size).toBe(0)
    }
  }
)

it('committed hydration survives actual skipped-lane replay, force loading and terminal failure', async () => {
  const s = store()
  const first = deferred<LinearIssue | null>(),
    h = deferred<LinearIssue | null>()
  let rejectReplacement!: (error: Error) => void
  const replacement = new Promise<LinearIssue | null>((_resolve, reject) => {
    rejectReplacement = reject
  })
  reads.detail
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(h.promise)
    .mockReturnValueOnce(replacement)
  const pending = deferred<{ ok: boolean }>(),
    blocked = deferred<void>()
  let hold = true
  let enroll!: () => void
  let saving!: Promise<{ ok: boolean }>
  const committed: string[] = [],
    rendered: string[] = []
  function Detail() {
    const [low, setLow] = useState(false)
    const detail = useLinearIssueWorkspaceDetail({
      issue: task(),
      providerSettings: defaultScopeSource(null),
      requestKey: 'H'
    })
    const value = `${detail.displayed.priority}:${detail.editState.priority}:${detail.issueLoading}:${low}`
    rendered.push(value)
    useLayoutEffect(() => {
      committed.push(value)
      enroll = () => setLow(true)
    })
    if (low && hold) {
      throw blocked.promise
    }
    return <output data-testid="replay">{value}</output>
  }
  const mounted = render(
    <Suspense fallback={<span>Blocked</span>}>
      <Detail />
    </Suspense>
  )
  await act(async () => {
    startTransition(() => {
      enroll()
      saving = writeLinearIssue(
        task(),
        { priority: 4 },
        defaultScopeSource(null),
        () => pending.promise
      )
    })
  })
  expect(rendered.some((value) => value.startsWith('4:4:') && value.endsWith(':true'))).toBe(true)
  expect(committed.some((value) => value.startsWith('4:4:'))).toBe(false)
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(reads.detail).toHaveBeenCalledTimes(2)
  await act(async () => {
    h.resolve({ ...task('H'), priority: 2 })
    await h.promise
  })
  expect(screen.getByTestId('replay').textContent).toBe('2:2:false:false')
  act(() => {
    s.getState().fetchLinearIssue(task().id, 'w', { force: true })
  })
  expect(reads.detail).toHaveBeenCalledTimes(3)
  expect(screen.getByTestId('replay').textContent).toBe('2:2:true:false')
  hold = false
  await act(async () => {
    blocked.resolve()
    await blocked.promise
  })
  expect(screen.getByTestId('replay').textContent).toBe('2:2:true:true')
  await act(async () => {
    rejectReplacement(new Error('offline'))
    await replacement.catch(() => {})
  })
  expect(screen.getByTestId('replay').textContent).toBe('2:2:false:true')
  expect(reads.detail).toHaveBeenCalledTimes(3)
  reads.detail.mockResolvedValueOnce({ ...task('G'), priority: 3 })
  await act(async () => {
    s.getState().fetchLinearIssue(task().id, 'w', { force: true })
  })
  expect(screen.getByTestId('replay').textContent).toBe('3:3:false:true')
  mounted.unmount()
  first.resolve(task('retired'))
  await first.promise
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
  act(() => s.getState().patchLinearIssue(task().id, { priority: 4 }))
  expect(reads.detail).toHaveBeenCalledTimes(4)
})

it('acknowledges only captured field t, leaving newer u delivered before layout acknowledgement', async () => {
  const s = store(),
    context = defaultScopeSource(null)
  const t = deferred<{ ok: boolean }>(),
    u = deferred<{ ok: boolean }>()
  let savingT!: Promise<{ ok: boolean }>, savingU!: Promise<{ ok: boolean }>
  let current!: ReturnType<typeof useLinearIssuePublication>
  let publishU = false
  function Consumer() {
    useLayoutEffect(() => {
      if (publishU && publication.issue?.state.name === 'H') {
        publishU = false
        deferredIssueSetters.enabled = true
        savingU = writeLinearIssue(task(), { priority: 2 }, context, () => u.promise)
        deferredIssueSetters.enabled = false
      }
    })
    const publication = useLinearIssuePublication(task(), context)
    useLayoutEffect(() => {
      current = publication
    })
    return <output data-testid="ack">{publication.issue?.priority}</output>
  }
  const mounted = render(<Consumer />)
  act(() => {
    savingT = writeLinearIssue(task(), { priority: 4 }, context, () => t.promise)
  })
  reads.detail.mockResolvedValue({ ...task('H'), priority: 1 })
  const lease = s.getState().fetchLinearIssue(task().id, 'w', { force: true }).acquire()
  const view = await lease.waitForCurrentTerminal()
  publishU = true
  act(() => current.read(lease, view))
  expect(screen.getByTestId('ack').textContent).toBe('4')
  const delayedU = deferredIssueSetters.updates.splice(0)
  expect(delayedU.length).toBeGreaterThan(0)
  act(() => delayedU.forEach((deliver) => deliver()))
  expect(screen.getByTestId('ack').textContent).toBe('2')
  mounted.unmount()
  lease.release()
  u.resolve({ ok: false })
  t.resolve({ ok: false })
  await Promise.all([savingT, savingU])
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
})

it('committed field t reconstructs while newer u is in a genuinely suspended lane', async () => {
  store()
  const t = deferred<{ ok: boolean }>(),
    u = deferred<{ ok: boolean }>(),
    blocked = deferred<void>()
  let savingT!: Promise<{ ok: boolean }>, savingU!: Promise<{ ok: boolean }>
  let enqueue!: () => void, pulse!: () => void
  let hold = true
  const commits: string[] = []
  function Consumer() {
    const [low, setLow] = useState(false),
      [tick, setTick] = useState(0)
    const publication = useLinearIssuePublication(task(), defaultScopeSource(null))
    const value = `${publication.issue?.priority}:${low}:${tick}`
    useLayoutEffect(() => {
      enqueue = () => setLow(true)
      pulse = () => setTick((n) => n + 1)
      commits.push(value)
    })
    if (low && hold) {
      throw blocked.promise
    }
    return <output data-testid="field-replay">{value}</output>
  }
  const mounted = render(
    <Suspense fallback={<span>Blocked</span>}>
      <Consumer />
    </Suspense>
  )
  act(() => {
    savingT = writeLinearIssue(task(), { priority: 4 }, defaultScopeSource(null), () => t.promise)
  })
  expect(screen.getByTestId('field-replay').textContent).toBe('4:false:0')
  await act(async () => {
    startTransition(() => {
      enqueue()
      savingU = writeLinearIssue(task(), { priority: 2 }, defaultScopeSource(null), () => u.promise)
    })
  })
  expect(commits.some((value) => value.startsWith('2:'))).toBe(false)
  act(() => pulse())
  expect(screen.getByTestId('field-replay').textContent).toBe('4:false:1')
  hold = false
  await act(async () => {
    blocked.resolve()
    await blocked.promise
  })
  expect(screen.getByTestId('field-replay').textContent).toBe('2:true:1')
  mounted.unmount()
  t.resolve({ ok: false })
  u.resolve({ ok: false })
  await Promise.all([savingT, savingU])
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
})
