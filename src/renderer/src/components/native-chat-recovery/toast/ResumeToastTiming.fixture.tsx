import { useCallback, useEffect, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import { resumeToastView } from './native-chat-resume-toast-view'
import { NativeChatResumeToast } from './NativeChatResumeToast'
import { useResumeToastAutoDismiss } from './use-resume-toast-auto-dismiss'

const chats: ResumeCandidate[] = [1, 2].map((index) => ({
  sessionId: `chat-${index}`,
  workspaceId: 'demo',
  agent: 'claude',
  trigger: 'update',
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
  const setDuration = useCallback(
    (duration: number) => {
      if (toast.getToasts().some((entry) => entry.id === id)) {
        toast.custom(() => <Report id={id} />, { id, duration })
      }
    },
    [id]
  )
  const { onDetailsOpened, interactionHandlers } = useResumeToastAutoDismiss(true, setDuration)
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
        onClose={() => toast.dismiss(id)}
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
        position="top-left"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}
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
