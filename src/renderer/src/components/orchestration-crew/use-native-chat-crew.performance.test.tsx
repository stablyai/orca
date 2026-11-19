// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'
import {
  useNativeChatCrew,
  useNativeChatCrewSource,
  useNativeChatCrewState
} from './use-native-chat-crew'

const rpc = vi.hoisted(() => {
  const calls: { method: string; params: unknown }[] = []
  return { live: 0, calls }
})

vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: async (_target: unknown, method: string, params: unknown) => {
    rpc.calls.push({ method, params })
    rpc.live++
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
    canMention: true,
    selfLabel: 'Claude'
  })
  useNativeChatCrew(source)
  useNativeChatCrewState(source)
  return null
}

// Ten split panes showing three chats; panes of one chat share its subscription.
const PANES = [0, 0, 0, 1, 1, 1, 2, 2, 2, 2].map((chat) => SESSIONS[chat])

function Panes(props: { windowVisible: boolean }) {
  return PANES.map((sessionId, index) => (
    <Chat key={index} sessionId={sessionId} isVisible={props.windowVisible} />
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
