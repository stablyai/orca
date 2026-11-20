// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'
import {
  NativeChatCrewContext,
  useNativeChatCrew,
  useNativeChatCrewSource,
  useNativeChatCrewState
} from './use-native-chat-crew'
import { useStructuredNativeChatSubagents } from '../native-chat/subagents/use-structured-native-chat-subagents'
import type { StructuredSessionBackgroundTasksView } from '../../../../shared/agent-session/view/structured-session-background-tasks-view'

const rpc = vi.hoisted(() => {
  const calls: { method: string; params: unknown }[] = []
  return { live: 0, calls, stripRenders: 0 }
})

vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: async (
    _target: unknown,
    method: string,
    params: unknown,
    handlers: { onEvent: (value: unknown) => void }
  ) => {
    rpc.calls.push({ method, params })
    rpc.live++
    // A crew of three that never changes.
    queueMicrotask(() =>
      handlers.onEvent({ type: 'summary', status: 'ok', agents: 3, needsYou: 0 })
    )
    let open = true
    return {
      unsubscribe: () => {
        if (open) {
          open = false
          rpc.live--
        }
      }
    }
  }
}))

vi.mock('../native-chat/tools/tasks/NativeChatBackgroundTasksStatus', () => ({
  NativeChatBackgroundTasksStatus: () => {
    rpc.stripRenders++
    return null
  }
}))

const SESSIONS = Array.from(
  { length: 10 },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
)
const composerRef = createRef<NativeChatComposerHandle>()

/** One chat as the pane mounts it: the strip and the composer's `@` reader share its source. */
function Chat(props: { sessionId: string; isVisible: boolean }) {
  const source = useNativeChatCrewSource({
    target: { kind: 'local' },
    sessionId: props.sessionId,
    isVisible: props.isVisible,
    composerRef,
    canMention: true
  })
  useNativeChatCrew(source)
  useNativeChatCrewState(source)
  return null
}

// Ten split panes showing three chats; panes of one chat share its subscription.
const PANES = [0, 0, 0, 1, 1, 1, 2, 2, 2, 2].map((chat, pane) => ({
  pane: `pane-${pane}`,
  sessionId: SESSIONS[chat]
}))

function Panes(props: { windowVisible: boolean }) {
  return PANES.map(({ pane, sessionId }) => (
    <Chat key={pane} sessionId={sessionId} isVisible={props.windowVisible} />
  ))
}

it('follows each visible chat once: ten panes of three chats hold three subscriptions, none once hidden', async () => {
  const view = render(<Panes windowVisible />)
  await act(async () => {})
  expect(rpc.calls.map((call) => call.params)).toEqual([
    { party: `orca_session_id:${SESSIONS[0]}`, view: 'summary', deltas: true },
    { party: `orca_session_id:${SESSIONS[1]}`, view: 'summary', deltas: true },
    { party: `orca_session_id:${SESSIONS[2]}`, view: 'summary', deltas: true }
  ])
  expect(rpc.live).toBe(3)

  view.rerender(<Panes windowVisible={false} />)
  await act(async () => {})
  expect(rpc.live).toBe(0)
  view.unmount()
})

const NO_WORK: StructuredSessionBackgroundTasksView = {
  show: false,
  isMonitoring: false,
  tasks: [],
  settledTasks: [],
  supportsStop: true,
  offersStopAll: false,
  incomplete: false
}

/** A chat as its session mounts it: each session update renders it with a new controller. */
function Session(_props: { update: number }) {
  const source = useNativeChatCrewSource({
    target: { kind: 'local' },
    sessionId: SESSIONS[9],
    isVisible: true,
    composerRef,
    canMention: true
  })
  const subagents = useStructuredNativeChatSubagents({
    sessionId: SESSIONS[9],
    paneKey: 'tab_chat:pane',
    isVisible: true,
    controller: { backgroundTasks: NO_WORK, stopBackgroundTask: async () => null }
  })
  return (
    <NativeChatCrewContext.Provider value={source}>
      {subagents.strip}
    </NativeChatCrewContext.Provider>
  )
}

it('keeps a closed crew strip still while its session updates and the crew sends nothing', async () => {
  const view = render(<Session update={0} />)
  await act(async () => {})
  expect(rpc.stripRenders).toBeGreaterThan(0)
  rpc.stripRenders = 0
  for (let update = 1; update <= 50; update++) {
    view.rerender(<Session update={update} />)
  }
  await act(async () => {})
  expect(rpc.stripRenders).toBe(0)
  view.unmount()
})
