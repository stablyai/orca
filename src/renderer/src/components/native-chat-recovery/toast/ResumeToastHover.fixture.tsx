import { useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import type { ResumeRun } from '../runs/native-chat-resume-run'
import {
  createNativeChatRestartStore,
  type NativeChatRestartStore
} from '../offers/native-chat-restart-runtime-store'
import type { NativeChatRestartOffer } from '../offers/native-chat-restart-host-offer'
import { NativeChatResumeToastHost } from './NativeChatResumeToastHost'

const NOW = 1_800_000_000_000
const noop = (): void => {}

const chats: ResumeCandidate[] = Array.from({ length: 25 }, (_, index) => ({
  sessionId: `hover-chat-${index}`,
  workspaceId: 'demo-workspace',
  agent: 'claude',
  trigger: 'quit',
  latestPrompt: `Demo task ${index}`,
  recordedAt: NOW - 60_000
}))
const failed: ResumeFailure = {
  ...chats[0]!,
  failedAt: NOW,
  outcome: 'refused',
  reason: 'agent_session_not_attached',
  retryable: false
}
const run: ResumeRun = {
  startedAt: NOW,
  startedBy: 'launch',
  entries: chats.map((candidate) => ({ candidate })),
  inFlight: false,
  continued: chats
    .slice(1)
    .map((candidate) => ({ sessionId: candidate.sessionId, outcome: 'continued' }))
}
const offer: NativeChatRestartOffer = { candidates: [], failed: [failed], listedAt: NOW }

let nextHost = 0
/** "Couldn't resume 1 of 25", over a server store whose reads are pinned and whose actions do nothing. */
function stubStore(): NativeChatRestartStore {
  const store = createNativeChatRestartStore({
    kind: 'environment',
    environmentId: `fixture-hover-${++nextHost}`
  })
  return {
    ...store,
    subscribe: () => noop,
    getNativeChatRestartOffer: () => offer,
    getNativeChatRestartRun: () => run,
    subscribeNativeChatResumeOnRestartDialog: () => noop,
    getNativeChatResumeOnRestartDialogRequest: () => true,
    consumeNativeChatResumeOnRestartDialogRequest: noop,
    releaseFinishedNativeChatRestartRun: noop,
    markFinishedNativeChatRestartRunShown: noop,
    continueNativeChatRestartOffer: async () => {},
    dismissNativeChatRestartOffer: async () => {}
  }
}

function Corner(): React.JSX.Element {
  const [store] = useState(stubStore)
  // transform pins the app's fixed-position toaster to this frame instead of the viewport.
  return (
    <div
      className="relative h-40 overflow-hidden bg-background"
      style={{ transform: 'translateZ(0)' }}
    >
      <div className="absolute inset-x-0 bottom-0 h-10 border-t border-border bg-sidebar" />
      <Toaster />
      <NativeChatResumeToastHost store={store} offerEnabled />
    </div>
  )
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function card(frame: HTMLElement): HTMLElement {
  const found = frame.querySelector<HTMLElement>('[data-sonner-toast] section')
  if (!found) {
    throw new Error('The resume report never appeared')
  }
  return found
}

// 600px is the narrowest main window, where the toaster also switches to its narrow layout.
export const corner = defineFixture({ width: 600, render: () => <Corner /> })

/** Hovering expands the toaster; the report must stay exactly where it was. */
export const hoverStaysPut = defineFixture({
  width: 600,
  render: () => <Corner />,
  interact: async (frame) => {
    // Past the chunk load and the toaster's 400ms enter transition.
    await wait(800)
    const before = card(frame).getBoundingClientRect().top
    card(frame).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    card(frame).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await wait(600)
    const after = card(frame).getBoundingClientRect().top
    if (Math.abs(after - before) > 0.5) {
      throw new Error(`Hovering moved the resume report by ${after - before}px`)
    }
  }
})
