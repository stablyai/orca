import { useCallback, useEffect, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import { resumeToastView } from './native-chat-resume-toast-view'
import { NativeChatResumeToast } from './NativeChatResumeToast'
import { useResumeToastAutoDismiss } from './use-resume-toast-auto-dismiss'

const chats: ResumeCandidate[] = Array.from({ length: 20 }, (_, index) => ({
  sessionId: `chat-${index}`,
  workspaceId: 'demo',
  agent: 'claude',
  trigger: 'quit',
  latestPrompt: `Demo task ${index}`,
  recordedAt: 1
}))
const view = resumeToastView(
  {
    startedAt: 1,
    startedBy: 'launch',
    entries: chats.map((candidate) => ({ candidate })),
    inFlight: false,
    continued: chats.map((candidate) => ({ sessionId: candidate.sessionId, outcome: 'continued' }))
  },
  [],
  new Map()
)
let nextId = 0
const noop = (): void => {}

function Report({ id }: { id: string }): React.JSX.Element {
  const close = useCallback(() => {
    toast.dismiss(id)
  }, [id])
  const root = useRef<HTMLDivElement>(null)
  const { onDetailsOpened } = useResumeToastAutoDismiss(true, close, root)
  return (
    <div ref={root}>
      <NativeChatResumeToast
        view={view}
        listedAt={1}
        nameFor={(_id, fallback) => fallback}
        onResume={noop}
        onRowAction={noop}
        onOpenSettings={noop}
        onDetailsOpened={onDetailsOpened}
        onClose={close}
      />
    </div>
  )
}

function Timing(): React.JSX.Element {
  const [id] = useState(() => `fixture-resume-timing-${++nextId}`)
  useEffect(() => {
    const timer = setTimeout(() => {
      toast.custom(() => <Report id={id} />, { id, duration: Infinity, unstyled: true })
    }, 50)
    return () => {
      clearTimeout(timer)
      toast.dismiss(id)
    }
  }, [id])
  return (
    <div style={{ position: 'relative', height: 120 }}>
      <Toaster
        position="bottom-right"
        style={{ position: 'absolute', bottom: 0, right: 0, width: '100%' }}
      />
    </div>
  )
}

const render = (): React.JSX.Element => <Timing />
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const reportShown = (frame: HTMLElement): boolean =>
  frame
    .querySelector('[role=status]')
    ?.textContent?.includes('Resumed 20 agents after the restart.') === true

function expectReport(frame: HTMLElement, shown: boolean, why: string): void {
  if (reportShown(frame) !== shown) {
    throw new Error(why)
  }
}

// Drive window focus directly so each case controls what document.hasFocus() reports.
function setWindowFocus(focused: boolean, { deliverEvent }: { deliverEvent: boolean }): void {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
  if (deliverEvent) {
    window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
  }
}

// On macOS, Chromium can keep reporting a window as hidden after it is back on screen.
async function whileDocumentReportsHidden(run: () => Promise<void>): Promise<void> {
  Object.defineProperties(document, {
    hidden: { configurable: true, value: true },
    visibilityState: { configurable: true, value: 'hidden' }
  })
  document.dispatchEvent(new Event('visibilitychange'))
  try {
    await run()
  } finally {
    Reflect.deleteProperty(document, 'hidden')
    Reflect.deleteProperty(document, 'visibilityState')
    Reflect.deleteProperty(document, 'hasFocus')
    document.dispatchEvent(new Event('visibilitychange'))
  }
}

export const initial = defineFixture({ width: 448, render, interact: () => wait(300) })
export const dismissed = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    expectReport(frame, true, 'Expected the successful restart report to appear')
    await wait(5700)
    expectReport(frame, false, 'The report stayed open five seconds after it was shown')
  }
})
export const visibleButUnfocused = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    // A visible window behind another app still shows the report, so it still leaves on time.
    setWindowFocus(false, { deliverEvent: true })
    try {
      await wait(5700)
      expectReport(frame, false, 'The report stayed open on a visible but unfocused window')
    } finally {
      Reflect.deleteProperty(document, 'hasFocus')
    }
  }
})
export const hovered = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    frame
      .querySelector('[data-sonner-toast]')
      ?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
    await wait(6000)
    expectReport(frame, true, 'The report left while the pointer was on it')
  }
})
export const keyboardFocused = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    // Alt+T then Tab lands on Sonner's own toast element, outside the report's wrapper.
    frame.querySelector<HTMLElement>('[data-sonner-toast]')?.focus()
    await wait(6000)
    expectReport(frame, true, 'The report left while keyboard focus was on the toast')
  }
})
export const restoredWithStaleVisibility = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    expectReport(frame, true, 'Expected the successful restart report to appear')
    await whileDocumentReportsHidden(async () => {
      await wait(5500)
      expectReport(frame, true, 'The report expired while the window was hidden')
      setWindowFocus(true, { deliverEvent: true })
      await wait(4000)
      expectReport(frame, true, 'The report did not get a fresh five seconds after focus')
      await wait(1600)
      expectReport(frame, false, 'The report stayed open five seconds after focus')
    })
  }
})
export const blurredAgainWhileHidden = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    await whileDocumentReportsHidden(async () => {
      setWindowFocus(true, { deliverEvent: true })
      await wait(3000)
      // Leaving the window again means the stale hidden flag no longer proves anyone is looking.
      setWindowFocus(false, { deliverEvent: true })
      await wait(4000)
      expectReport(frame, true, 'The report expired after the window lost focus')
      setWindowFocus(true, { deliverEvent: true })
      await wait(4000)
      expectReport(frame, true, 'The report did not get a fresh five seconds after focus')
      await wait(1600)
      expectReport(frame, false, 'The report stayed open five seconds after focus')
    })
  }
})
export const focusLostAtExpiryWhileHidden = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    await whileDocumentReportsHidden(async () => {
      setWindowFocus(true, { deliverEvent: true })
      await wait(4800)
      // Focus is gone at the deadline, but its blur has not reached the report yet.
      setWindowFocus(false, { deliverEvent: false })
      await wait(1000)
      expectReport(frame, true, 'The report expired after focus left, before its blur arrived')
      setWindowFocus(false, { deliverEvent: true })
      setWindowFocus(true, { deliverEvent: true })
      await wait(4000)
      expectReport(frame, true, 'The report did not get a fresh five seconds after focus')
      await wait(1600)
      expectReport(frame, false, 'The report stayed open five seconds after focus')
    })
  }
})
export const visibleAfterFocusLostAtExpiry = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    await whileDocumentReportsHidden(async () => {
      setWindowFocus(true, { deliverEvent: true })
      await wait(4800)
      // Focus leaves without a blur, so the deadline is skipped with focus still cached.
      setWindowFocus(false, { deliverEvent: false })
      await wait(1000)
      expectReport(frame, true, 'The report expired after focus left, before its blur arrived')
    })
    // The document turns visible again while the window stays unfocused.
    setWindowFocus(false, { deliverEvent: false })
    try {
      await wait(4000)
      expectReport(frame, true, 'The report did not get a fresh five seconds once visible')
      await wait(1600)
      expectReport(frame, false, 'The report stuck after the document became visible again')
    } finally {
      Reflect.deleteProperty(document, 'hasFocus')
    }
  }
})
export const visibleBeforeDeadlineAfterFocusLost = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    await whileDocumentReportsHidden(async () => {
      setWindowFocus(true, { deliverEvent: true })
      await wait(2000)
      // Focus leaves without a blur, well before the deadline.
      setWindowFocus(false, { deliverEvent: false })
      await wait(1300)
    })
    // The document turns visible at 3.3 s; the report should count five fresh seconds from here.
    setWindowFocus(false, { deliverEvent: false })
    try {
      await wait(4000)
      expectReport(
        frame,
        true,
        'The report kept its old deadline after the document became visible'
      )
      await wait(1600)
      expectReport(frame, false, 'The report stayed open five seconds after becoming visible')
    } finally {
      Reflect.deleteProperty(document, 'hasFocus')
    }
  }
})
