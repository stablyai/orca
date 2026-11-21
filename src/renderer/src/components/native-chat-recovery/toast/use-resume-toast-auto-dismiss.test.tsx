// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCallback } from 'react'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import type { ResumeRun } from '../runs/native-chat-resume-run'
import { resumeToastView, type ResumeToastView } from './native-chat-resume-toast-view'
import { NativeChatResumeToast } from './NativeChatResumeToast'
import { useResumeToastAutoDismiss } from './use-resume-toast-auto-dismiss'

let id = 0
const toastId = (): string => `resume-test-${id}`
const EXIT_MS = 400

function chat(index: number): ResumeCandidate {
  return {
    sessionId: `chat-${index}`,
    workspaceId: 'demo-workspace',
    agent: 'claude',
    trigger: 'update',
    latestPrompt: `Demo task ${index}`,
    recordedAt: 1
  }
}

function run(outcome: 'continued' | 'unknown'): ResumeRun {
  const chats = [chat(1), chat(2)]
  return {
    startedAt: 1,
    startedBy: 'launch',
    entries: chats.map((candidate) => ({ candidate })),
    inFlight: false,
    continued: chats.map((candidate) => ({ sessionId: candidate.sessionId, outcome }))
  }
}

const allResumed = resumeToastView(run('continued'), [], new Map())
const onAutoClose = vi.fn()

/** Wired like the app's report: the toaster owns the timer, the hook sets its duration. */
function Report({ view }: { view: ResumeToastView }): React.JSX.Element {
  const setDuration = useCallback(
    (duration: number) => {
      if (toast.getToasts().some((entry) => entry.id === toastId())) {
        toast.custom(() => <Report view={view} />, { id: toastId(), duration })
      }
    },
    [view]
  )
  const { onDetailsOpened, interactionHandlers } = useResumeToastAutoDismiss(
    view.phase === 'finished' && view.counts.needsYou === 0,
    setDuration
  )
  return (
    <div {...interactionHandlers}>
      <NativeChatResumeToast
        view={view}
        listedAt={1}
        nameFor={(_id, fallback) => fallback}
        onResume={() => {}}
        onRowAction={() => {}}
        onOpenSettings={() => {}}
        onDetailsOpened={onDetailsOpened}
        onClose={() => toast.dismiss(toastId())}
      />
    </div>
  )
}

function show(view: ResumeToastView): void {
  render(<Toaster />)
  act(() => {
    toast.custom(() => <Report view={view} />, {
      id: toastId(),
      duration: Infinity,
      unstyled: true,
      onAutoClose
    })
  })
  advance(1)
  advance(1)
  advance(1)
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const headline = (): HTMLElement | null => screen.queryByText(/Resumed 2 chats/)

describe('resume report auto-dismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    id += 1
    onAutoClose.mockClear()
  })
  afterEach(() => {
    act(() => {
      toast.dismiss()
      vi.runOnlyPendingTimers()
    })
    cleanup()
    vi.useRealTimers()
  })

  it('leaves on its own after five seconds', () => {
    show(allResumed)
    advance(5000 - 100)
    expect(headline()).not.toBeNull()
    advance(100)
    advance(EXIT_MS)
    advance(EXIT_MS)
    expect(headline()).toBeNull()
    expect(onAutoClose).toHaveBeenCalledTimes(1)
  })

  it('holds when the report finishes under the pointer, then dismisses after it leaves', () => {
    const resuming = resumeToastView(
      { ...run('continued'), inFlight: true, continued: undefined },
      [],
      new Map()
    )
    show(resuming)
    const root = screen.getByRole('status').parentElement!
    const toaster = document.querySelector('[data-sonner-toaster]')!
    fireEvent.pointerEnter(root)
    fireEvent.mouseMove(toaster)
    act(() => {
      toast.custom(() => <Report view={allResumed} />, { id: toastId() })
    })
    advance(2)
    advance(2)
    advance(2)
    advance(6000)
    expect(headline()).not.toBeNull()
    fireEvent.pointerLeave(root)
    fireEvent.mouseLeave(toaster)
    advance(2)
    advance(2)
    advance(4900)
    expect(headline()).not.toBeNull()
    advance(100)
    advance(EXIT_MS)
    advance(EXIT_MS)
    expect(headline()).toBeNull()
  })

  it('holds while keyboard focus is inside', () => {
    show(allResumed)
    const details = screen.getByRole('button', { name: 'Details' })
    advance(3000)
    act(() => details.focus())
    advance(2)
    advance(2)
    advance(5000 * 3)
    expect(headline()).not.toBeNull()
    act(() => details.blur())
    advance(2)
    advance(2)
    advance(4900)
    expect(headline()).not.toBeNull()
    advance(100)
    advance(EXIT_MS)
    advance(EXIT_MS)
    expect(headline()).toBeNull()
  })

  it('stays once Details is opened, and Close still closes it', () => {
    show(allResumed)
    const details = screen.getByRole('button', { name: 'Details' })
    fireEvent.click(details)
    act(() => details.blur())
    advance(5000 * 4)
    expect(headline()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    advance(EXIT_MS)
    advance(EXIT_MS)
    expect(headline()).toBeNull()
    expect(onAutoClose).not.toHaveBeenCalled()
  })

  it('keeps a report that needs the person until it is closed', () => {
    show(resumeToastView(run('unknown'), [], new Map()))
    advance(5000 * 4)
    expect(screen.queryByRole('status')).not.toBeNull()
    expect(onAutoClose).not.toHaveBeenCalled()
  })
})
