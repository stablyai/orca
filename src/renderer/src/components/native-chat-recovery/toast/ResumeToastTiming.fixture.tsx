import { useCallback, useEffect, useState } from 'react'
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
  const { onDetailsOpened, interactionHandlers } = useResumeToastAutoDismiss(true, close)
  return (
    <div {...interactionHandlers}>
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
export const initial = defineFixture({ width: 448, render, interact: () => wait(300) })
export const hovered = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    await wait(300)
    frame
      .querySelector('[role=status]')
      ?.parentElement?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    frame
      .querySelector('[data-sonner-toaster]')
      ?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await wait(6000)
  }
})
export const dismissed = defineFixture({ width: 448, render, interact: () => wait(6000) })
export const restoredWithStaleVisibility = defineFixture({
  width: 448,
  render,
  interact: async (frame) => {
    const report = () =>
      frame
        .querySelector('[role=status]')
        ?.textContent?.includes('Resumed 20 chats after the restart.')
    await wait(300)
    if (!report()) {
      throw new Error('Expected the successful restart report to appear')
    }
    Object.defineProperties(document, {
      hidden: { configurable: true, value: true },
      visibilityState: { configurable: true, value: 'hidden' }
    })
    document.dispatchEvent(new Event('visibilitychange'))
    try {
      await wait(5500)
      if (!report()) {
        throw new Error('The report expired while the window was hidden')
      }
      // On macOS, the window can regain focus while Chromium still reports it hidden.
      window.dispatchEvent(new Event('focus'))
      await wait(4000)
      if (!report()) {
        throw new Error('The report did not get a fresh five seconds after window focus')
      }
      await wait(1600)
      if (report()) {
        throw new Error(
          'The report stayed open after the focused window had five seconds to show it'
        )
      }
    } finally {
      Reflect.deleteProperty(document, 'hidden')
      Reflect.deleteProperty(document, 'visibilityState')
      document.dispatchEvent(new Event('visibilitychange'))
    }
  }
})
