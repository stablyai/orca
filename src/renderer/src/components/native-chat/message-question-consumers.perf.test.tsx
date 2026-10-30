// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useNativeChatCurrentQuestions } from './use-native-chat-current-questions'
import { useNativeChatInteractivePromptCard } from './use-native-chat-interactive-prompt-card'
import { messageQuestionFixture } from '../../../../shared/message-question-occurrence.test-fixture'
import type { AgentSessionCurrentRequestsMarker } from '../../../../shared/agent-session-current-requests-wire'
import type { createNativeChatCurrentRequestsBinding } from '../../../../shared/native-chat-current-requests-binding'

const initial = useAppStore.getInitialState()
const messages: NativeChatMessage[] = []
const bindings = new Map<number, ReturnType<typeof createNativeChatCurrentRequestsBinding>>()
const renders = new Map<number, number>()
let reads = 0
function marker(index: number): AgentSessionCurrentRequestsMarker {
  return {
    contract: 'agent-session.current-requests.v2',
    sessionId: `chat-${index}`,
    epoch: `source-${index}`,
    publisher: `host-${index}`,
    revision: 1,
    owner: `host-${index}:root`,
    version: `version-${index}`
  }
}
function Consumer({ index }: { index: number }) {
  const [, view, bind] = useNativeChatCurrentQuestions({
    paneKey: `pane-${index}`,
    agent: 'codex',
    sessionId: `chat-${index}`,
    runtimeEnvironmentId: `host-${index}`
  })
  useEffect(() => {
    const current = bind(async () => {
      reads++
      return {
        marker: marker(index),
        nextCursor: null,
        json: JSON.stringify({
          blocking: [],
          asyncQuestions: [messageQuestionFixture(`question-${index}`)],
          context: { sessionId: `chat-${index}`, boundary: 'root' }
        })
      }
    })
    bindings.set(index, current)
    return () => {
      bindings.delete(index)
      current.invalidate()
    }
  }, [bind, index])
  const card = useNativeChatInteractivePromptCard({
    paneKey: `pane-${index}`,
    asyncQuestion: view.asyncQuestion,
    messages,
    transcriptSettled: true
  })
  renders.set(index, (renders.get(index) ?? 0) + 1)
  return (
    <output data-testid={`chat-${index}`}>
      {card?.kind === 'question' ? card.prompt.questions[0].question : 'empty'}
    </output>
  )
}
afterEach(() => {
  cleanup()
  bindings.clear()
  renders.clear()
  useAppStore.setState(initial, true)
})

it.each([10, 100])(
  'isolates real complete-record and store updates across %i mounted chat consumers',
  async (count) => {
    for (let index = 0; index < count; index++) {
      useAppStore
        .getState()
        .setAgentStatus(`pane-${index}`, { agentType: 'codex', state: 'working', prompt: '' })
    }
    render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <Consumer key={index} index={index} />
        ))}
      </>
    )
    await act(async () => {})
    reads = 0
    renders.clear()
    for (let tick = 0; tick < 50; tick++) {
      await act(async () => {
        useAppStore
          .getState()
          .setAgentStatus(tick % 2 === 0 ? 'unrelated-pane' : 'pane-0', {
            agentType: 'codex',
            state: 'working',
            prompt: `other-host-${tick}`
          })
      })
    }
    expect(reads).toBe(0)
    expect([...renders.values()]).toEqual([])
    await act(async () => bindings.get(0)?.observe({ type: 'append', currentRequests: marker(0) }))
    expect(screen.getByTestId('chat-0').textContent).toBe('Which color?')
    expect(reads).toBe(1)
    expect(renders.get(0)).toBeGreaterThan(0)
    expect([...renders.keys()]).toEqual([0])
    expect(screen.getByTestId(`chat-${count - 1}`).textContent).toBe('empty')
  }
)
