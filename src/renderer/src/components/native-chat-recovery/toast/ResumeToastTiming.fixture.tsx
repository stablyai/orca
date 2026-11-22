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
      window.dispatchEvent(new Event('focus'))
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
      window.dispatchEvent(new Event('focus'))
      await wait(3000)
      // Leaving the window again means the stale hidden flag no longer proves anyone is looking.
      window.dispatchEvent(new Event('blur'))
      await wait(4000)
      expectReport(frame, true, 'The report expired after the window lost focus')
      window.dispatchEvent(new Event('focus'))
      await wait(4000)
      expectReport(frame, true, 'The report did not get a fresh five seconds after focus')
      await wait(1600)
      expectReport(frame, false, 'The report stayed open five seconds after focus')
    })
  }
})
