// @vitest-environment happy-dom

import { act, renderHook, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTaskCreationDraftRetention } from './use-task-creation-draft-retention'

import { store, reads } from './task-page/linear/task-page-linear-refresh-test-fixtures'
import {
  useLinearIssueCreationForm,
  useTaskPageLinearCreationState
} from './task-page/linear/use-task-page-linear-creation-state'
import { useTaskPageJiraCreationStatePrelude } from './task-page/jira/use-task-page-jira-creation-state'
import {
  writeNewLinearProjectDraft,
  writeNewJiraIssueDraft
} from './task-page/task-page-draft-storage'
import { deferred } from '../store/slices/linear-slice-test-harness'
import {
  createElement,
  Suspense,
  startTransition,
  useLayoutEffect,
  useCallback,
  useEffect,
  useState
} from 'react'

type Draft = { title: string; body: string }

const emptyDraft = (): Draft => ({ title: '', body: '' })

describe('useTaskCreationDraftRetention', () => {
  it('does not fan out writes while typing and saves the latest text on dismissal', () => {
    const writeDraft = vi.fn()
    const view = renderHook(
      ({ open, draft }) => useTaskCreationDraftRetention({ open, draft, writeDraft }),
      { initialProps: { open: true, draft: emptyDraft() } }
    )

    view.rerender({ open: true, draft: { title: 'Bug', body: '' } })
    view.rerender({ open: true, draft: { title: 'Bug', body: 'Latest details' } })

    expect(writeDraft).not.toHaveBeenCalled()

    view.rerender({ open: false, draft: emptyDraft() })

    expect(writeDraft).toHaveBeenCalledOnce()
    expect(writeDraft).toHaveBeenCalledWith({ title: 'Bug', body: 'Latest details' })
  })

  it('saves the latest text when an open composer unmounts', () => {
    const writeDraft = vi.fn()
    const view = renderHook(
      ({ draft }) => useTaskCreationDraftRetention({ open: true, draft, writeDraft }),
      { initialProps: { draft: { title: 'First', body: '' } } }
    )
    view.rerender({ draft: { title: 'Latest', body: 'Details' } })

    view.unmount()

    expect(writeDraft).toHaveBeenCalledOnce()
    expect(writeDraft).toHaveBeenCalledWith({ title: 'Latest', body: 'Details' })
  })

  it('clears a successful draft without resurrecting it during close cleanup', () => {
    const writeDraft = vi.fn()
    const view = renderHook(
      ({ open }) =>
        useTaskCreationDraftRetention({
          open,
          draft: { title: 'Created', body: 'Details' },
          writeDraft
        }),
      { initialProps: { open: true } }
    )

    act(() => view.result.current())
    view.rerender({ open: true })
    view.rerender({ open: false })
    view.unmount()

    expect(writeDraft).toHaveBeenCalledOnce()
    expect(writeDraft).toHaveBeenCalledWith(null)
  })

  it('does not create a draft when an unopened composer unmounts', () => {
    const writeDraft = vi.fn()
    const view = renderHook(() =>
      useTaskCreationDraftRetention({ open: false, draft: emptyDraft(), writeDraft })
    )

    view.unmount()

    expect(writeDraft).not.toHaveBeenCalled()
  })
})

it.each([false, true])(
  'real skipped title and replayed body/completion retain the whole successor (close before success=$0)',
  async (closeBeforeSuccess) => {
    const s = store(),
      blocked = deferred<void>()
    const save = vi.spyOn(s.getState(), 'setNewLinearIssueDraft')
    const clear = vi.spyOn(s.getState(), 'clearNewLinearIssueDraft')
    let form!: ReturnType<typeof useLinearIssueCreationForm>, low!: () => void
    let hold = true
    const renders: string[] = [],
      commits: string[] = []
    function Composer() {
      const [pending, setPending] = useState(false)
      const current = useLinearIssueCreationForm('R1', {
        open: true,
        title: 'Original',
        body: 'Body'
      })
      const value = `${current.newLinearIssueTitle}/${current.newLinearIssueBody}/${current.newLinearIssueOpen}`
      renders.push(value)
      useLayoutEffect(() => {
        form = current
        low = () => setPending(true)
        commits.push(value)
      })
      if (pending && hold) {
        throw blocked.promise
      }
      return createElement('output', { 'data-testid': 'draft-queue' }, value)
    }
    const view = render(createElement(Suspense, { fallback: 'Held' }, createElement(Composer)))
    const titleSetter = form.setNewLinearIssueTitle
    await act(async () => {
      startTransition(() => {
        form.setNewLinearIssueTitle('Queued title')
        low()
      })
    })
    expect(renders).toContain('Queued title/Body/true')
    expect(commits).not.toContain('Queued title/Body/true')
    act(() => form.setNewLinearIssueBody('Current body'))
    const submitted = form.captureNewLinearIssueDraft()
    expect(save).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    if (closeBeforeSuccess) {
      act(() => form.setNewLinearIssueOpen(false))
      expect(s.getState().newLinearIssueDraft).toBe(submitted.draft)
      expect(s.getState().newLinearIssueDraft).toEqual({ title: 'Original', body: 'Current body' })
    }
    act(() => form.completeNewLinearIssueDraft(submitted))
    expect(s.getState().newLinearIssueDraft).toBeNull()
    expect(form.newLinearIssueOpen).toBe(false)
    hold = false
    await act(async () => {
      blocked.resolve()
      await blocked.promise
    })
    expect(screen.getByTestId('draft-queue').textContent).toBe(
      `Queued title/Current body/${!closeBeforeSuccess}`
    )
    expect(form.setNewLinearIssueTitle).toBe(titleSetter)
    if (closeBeforeSuccess) {
      const saved = s.getState().newLinearIssueDraft
      expect.soft(saved).toEqual({ title: 'Queued title', body: 'Current body' })
      act(() => {
        form.setNewLinearIssueTitle(saved?.title ?? '')
        form.setNewLinearIssueBody(saved?.body ?? '')
        form.setNewLinearIssueOpen(true)
      })
      expect.soft(form.newLinearIssueTitle).toBe('Queued title')
      expect.soft(form.newLinearIssueBody).toBe('Current body')
    } else {
      expect(s.getState().newLinearIssueDraft).toBeNull()
    }
    act(() => {
      form.setNewLinearIssueTitle((v) => `${v} final`)
      form.setNewLinearIssueBody((v) => `${v} final`)
      form.setNewLinearIssueOpen(false)
    })
    expect(s.getState().newLinearIssueDraft).toEqual({
      title: 'Queued title final',
      body: 'Current body final'
    })
    act(() => {
      const saved = s.getState().newLinearIssueDraft!
      form.setNewLinearIssueTitle(saved.title)
      form.setNewLinearIssueBody(saved.body)
      form.setNewLinearIssueOpen(true)
    })
    expect(form).toMatchObject({
      newLinearIssueTitle: 'Queued title final',
      newLinearIssueBody: 'Current body final',
      newLinearIssueOpen: true
    })
    view.unmount()
  }
)

it.each([
  { title: 'Old', body: 'Body' },
  { title: '', body: '' },
  { title: ' \t', body: '\n ' }
])(
  'queued old-runtime text composes before the actual prelude handoff, never after it (initial=$title/$body)',
  async (initial) => {
    const s = store(),
      blocked = deferred<void>()
    let form!: ReturnType<typeof useLinearIssueCreationForm>,
      change!: (runtime: string) => void,
      low!: () => void
    let hold = true
    const commits: string[] = [],
      seen: string[] = []
    function Composer() {
      const [runtime, setRuntime] = useState('R1'),
        [pending, setPending] = useState(false)
      const enroll = useCallback(() => setPending(true), [])
      const current = useLinearIssueCreationForm(runtime, { open: true, ...initial })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real prelude consumes only Linear reset and inert Jira state on this runtime transition.
      useTaskPageJiraCreationStatePrelude({
        ...current,
        providerRuntimeContextKey: runtime,
        setNewLinearIssueProjects: vi.fn(),
        setNewLinearIssueProjectsLoading: vi.fn()
      } as never)
      const value = `${runtime}/${current.newLinearIssueTitle}/${current.newLinearIssueBody}/${current.newLinearIssueOpen}`
      seen.push(value)
      useLayoutEffect(() => {
        form = current
        change = setRuntime
        low = enroll
        commits.push(value)
      }, [current, value, enroll])
      if (pending && hold) {
        throw blocked.promise
      }
      return null
    }
    const view = render(createElement(Suspense, { fallback: null }, createElement(Composer)))
    const old = form
    await act(async () => {
      startTransition(() => {
        old.setNewLinearIssueTitle('Queued old')
        old.setNewLinearIssueBody('Queued body')
        low()
      })
    })
    expect(seen).toContain('R1/Queued old/Queued body/true')
    expect(commits).not.toContain('R1/Queued old/Queued body/true')
    act(() => change('R2'))
    expect(commits).toContain('R2///false')
    expect(commits).not.toContain('R1/Queued old/Queued body/true')
    expect(s.getState().newLinearIssueDraft).toEqual(initial.title.trim() ? initial : null)
    hold = false
    await act(async () => {
      blocked.resolve()
      await blocked.promise
    })
    expect(form.newLinearIssueOpen).toBe(false)
    const saved = s.getState().newLinearIssueDraft
    expect.soft(saved).toEqual({ title: 'Queued old', body: 'Queued body' })
    act(() => {
      form.setNewLinearIssueTitle(saved?.title ?? '')
      form.setNewLinearIssueBody(saved?.body ?? '')
      form.setNewLinearIssueOpen(true)
    })
    act(() => {
      old.setNewLinearIssueTitle('Late old')
      old.resetNewLinearIssue()
    })
    expect.soft(form.newLinearIssueTitle).toBe('Queued old')
    expect.soft(form.newLinearIssueBody).toBe('Queued body')
    expect(form.newLinearIssueOpen).toBe(true)
    view.unmount()
  }
)

it('current-target layout actions precede delayed runtime reset and obsolete queued completion/finally', async () => {
  const s = store(),
    blocked = deferred<void>(),
    oldAttempt = {},
    replacement = {}
  let form!: ReturnType<typeof useLinearIssueCreationForm>,
    change!: (runtime: string) => void,
    low!: () => void,
    pulse!: () => void
  let hold = true,
    acquired = 0,
    released = 0
  const commits: string[] = [],
    seen: string[] = []
  s.setState({ persistedUIReady: false })
  reads.projects.mockResolvedValue({ items: [] })
  const teams = [{ id: 'team-1', workspaceId: 'w' }]
  function Composer() {
    const [runtime, setRuntime] = useState('R1'),
      [pending, setPending] = useState(false),
      [tick, setTick] = useState(0)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: actual creation state consumes these account/team/runtime inputs; tour readiness is disabled.
    const current = useTaskPageLinearCreationState({
      providerRuntimeContextKey: runtime,
      settings: null,
      activeModal: 'none',
      linearConnected: true,
      selectedLinearWorkspaceId: 'w',
      linearTaskSourceContext: null,
      availableTeams: teams
    } as never)
    const {
      setNewLinearIssueTitle,
      setNewLinearIssueBody,
      setNewLinearIssueOpen,
      setNewLinearIssueStateId,
      beginNewLinearIssue
    } = current
    const enroll = useCallback(() => setPending(true), [])
    const advance = useCallback(() => setTick((n) => n + 1), [])
    useLayoutEffect(() => {
      if (runtime === 'R1') {
        setNewLinearIssueTitle('Old')
        setNewLinearIssueBody('Body')
        setNewLinearIssueOpen(true)
      } else {
        setNewLinearIssueStateId('new-default')
        setNewLinearIssueTitle('Replacement')
        setNewLinearIssueBody('Replacement body')
        setNewLinearIssueOpen(true)
        beginNewLinearIssue(replacement)
      }
    }, [
      runtime,
      setNewLinearIssueTitle,
      setNewLinearIssueBody,
      setNewLinearIssueOpen,
      setNewLinearIssueStateId,
      beginNewLinearIssue
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: actual runtime reset owner receives its Linear inputs; Jira is closed and unrelated metadata callbacks are inert.
    useTaskPageJiraCreationStatePrelude({
      ...current,
      providerRuntimeContextKey: runtime
    } as never)
    useEffect(() => {
      acquired++
      return () => {
        released++
      }
    }, [current.setNewLinearIssueTitle])
    const value = `${runtime}/${current.newLinearIssueTitle}/${current.newLinearIssueSubmitting}/${tick}`
    seen.push(value)
    useLayoutEffect(() => {
      form = current
      change = setRuntime
      low = enroll
      pulse = advance
      commits.push(value)
    }, [current, value, enroll, advance])
    if (pending && hold) {
      throw blocked.promise
    }
    return null
  }
  const view = render(createElement(Suspense, { fallback: null }, createElement(Composer)))
  act(() => form.beginNewLinearIssue(oldAttempt))
  const old = form,
    submitted = old.captureNewLinearIssueDraft()
  seen.length = 0
  commits.length = 0
  await act(async () => {
    startTransition(() => {
      old.completeNewLinearIssueDraft(submitted)
      old.settleNewLinearIssue(oldAttempt)
      low()
    })
  })
  expect(seen).toContain('R1//false/0')
  expect(commits).not.toContain('R1//false/0')
  act(() => change('R2'))
  expect(form).toMatchObject({
    newLinearIssueOpen: true,
    newLinearIssueTitle: 'Replacement',
    newLinearIssueBody: 'Replacement body',
    newLinearIssueStateId: 'new-default',
    newLinearIssueSubmitting: true
  })
  hold = false
  await act(async () => {
    blocked.resolve()
    await blocked.promise
  })
  act(() => {
    old.settleNewLinearIssue(oldAttempt)
    old.setNewLinearIssueTitle('Late')
    old.resetNewLinearIssue()
    pulse()
  })
  expect(form).toMatchObject({
    newLinearIssueOpen: true,
    newLinearIssueTitle: 'Replacement',
    newLinearIssueSubmitting: true
  })
  expect(acquired).toBe(2)
  expect(released).toBe(1)
  act(() => form.settleNewLinearIssue(replacement))
  act(() => form.setNewLinearIssueOpen(false))
  expect(s.getState().newLinearIssueDraft).toEqual({
    title: 'Replacement',
    body: 'Replacement body'
  })
  view.unmount()
  expect(released).toBe(2)
})

it('unchanged exact issue success stays disarmed through harmless closed renders and unmount', () => {
  const s = store()
  const save = vi.spyOn(s.getState(), 'setNewLinearIssueDraft')
  const clear = vi.spyOn(s.getState(), 'clearNewLinearIssueDraft')
  const view = renderHook(() =>
    useLinearIssueCreationForm('R1', { open: true, title: 'Created', body: 'Details' })
  )
  const submitted = view.result.current.captureNewLinearIssueDraft()
  act(() => {
    view.result.current.setNewLinearIssueTitle((value) => value)
    view.result.current.setNewLinearIssuePriority(3)
  })
  expect(view.result.current.captureNewLinearIssueDraft()).toBe(submitted)
  expect(save).not.toHaveBeenCalled()
  expect(clear).not.toHaveBeenCalled()
  act(() => view.result.current.completeNewLinearIssueDraft(submitted))
  expect(view.result.current.newLinearIssueOpen).toBe(false)
  expect(s.getState().newLinearIssueDraft).toBeNull()
  act(() => view.result.current.setNewLinearIssuePriority(4))
  view.rerender()
  expect(view.result.current.captureNewLinearIssueDraft()).toBe(submitted)
  view.unmount()
  expect(save).not.toHaveBeenCalled()
  expect(clear).toHaveBeenCalledOnce()
  expect(s.getState().newLinearIssueDraft).toBeNull()
})

it('project and Jira immediate discard keep their actual plain session slots cleared through close', () => {
  const s = store()
  const view = renderHook(
    ({ open }) => ({
      project: useTaskCreationDraftRetention({
        open,
        draft: { name: 'Project', description: 'Summary', content: 'Brief' },
        writeDraft: writeNewLinearProjectDraft
      }),
      jira: useTaskCreationDraftRetention({
        open,
        draft: { title: 'Jira', body: 'Details' },
        writeDraft: writeNewJiraIssueDraft
      })
    }),
    { initialProps: { open: true } }
  )
  view.rerender({ open: false })
  expect(s.getState().newLinearProjectDraft).toEqual({
    name: 'Project',
    description: 'Summary',
    content: 'Brief'
  })
  expect(s.getState().newJiraIssueDraft).toEqual({ title: 'Jira', body: 'Details' })
  view.rerender({ open: true })
  act(() => {
    view.result.current.project()
    view.result.current.jira()
  })
  view.rerender({ open: true })
  view.rerender({ open: false })
  view.unmount()
  expect(s.getState().newLinearProjectDraft).toBeNull()
  expect(s.getState().newJiraIssueDraft).toBeNull()
})
