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

const rpc = vi.hoisted(() => ({ live: 0, calls: [] as { method: string; params: unknown }[] }))

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
function Chat(props: { sessionId: string; isVisible: boolean; isFocusedGroup: boolean }) {
  const source = useNativeChatCrewSource({
    target: { kind: 'local' },
    sessionId: props.sessionId,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerRef,
    canMention: true,
    selfLabel: 'Claude'
  })
  useNativeChatCrew(source)
  useNativeChatCrewState(source)
  return null
}

function Panes(props: { focused: number | null; windowVisible: boolean }) {
  return SESSIONS.map((sessionId, index) => (
    <Chat
      key={sessionId}
      sessionId={sessionId}
      // Every split of the window is visible; only one group has focus.
      isVisible={props.windowVisible}
      isFocusedGroup={props.focused === index}
    />
  ))
}

it('follows one crew for ten panes: only the visible, focused chat subscribes', async () => {
  const view = render(<Panes focused={0} windowVisible />)
  await act(async () => {})
  expect(rpc.calls).toEqual([
    {
      method: 'orchestration.crewSubscribe',
      params: { party: `orca_session_id:${SESSIONS[0]}`, view: 'summary', deltas: true }
    }
  ])
  expect(rpc.live).toBe(1)

  view.rerender(<Panes focused={3} windowVisible />)
  await act(async () => {})
  expect(rpc.calls).toHaveLength(2)
  expect(rpc.live).toBe(1)

  view.rerender(<Panes focused={3} windowVisible={false} />)
  await act(async () => {})
  expect(rpc.live).toBe(0)
  view.unmount()
})
