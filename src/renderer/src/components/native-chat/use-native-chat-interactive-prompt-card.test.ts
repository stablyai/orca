// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { AgentStatusPayload } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

const { useAppStore } = await import('../../store')
const { useNativeChatInteractivePromptCard } =
  await import('./use-native-chat-interactive-prompt-card')

const paneKey = 'tab-card:leaf-card'
const NO_MESSAGES: readonly NativeChatMessage[] = []

function setStatus(payload: Omit<AgentStatusPayload, 'prompt' | 'agentType'>): void {
  useAppStore
    .getState()
    .setAgentStatus(paneKey, { prompt: 'Rename', agentType: 'claude', ...payload })
}

afterEach(() => {
  cleanup()
  useAppStore.setState({ agentStatusByPaneKey: {} })
})

describe('useNativeChatInteractivePromptCard', () => {
  // The hook runs in the pane's view, so each render here re-renders the whole transcript.
  it('does not re-render for a tool call that carries no prompt', () => {
    setStatus({ state: 'working', toolName: 'Read' })
    let renders = 0
    renderHook(() => {
      renders += 1
      return useNativeChatInteractivePromptCard({
        paneKey,
        messages: NO_MESSAGES,
        transcriptSettled: true
      })
    })
    const settled = renders

    act(() => setStatus({ state: 'working', toolName: 'Bash' }))
    act(() => setStatus({ state: 'working', toolName: 'Edit' }))

    expect(renders).toBe(settled)
  })

  it('still reads the prompt that arrives with a tool call', () => {
    setStatus({ state: 'working', toolName: 'Read' })
    const { result } = renderHook(() =>
      useNativeChatInteractivePromptCard({
        paneKey,
        messages: NO_MESSAGES,
        transcriptSettled: true
      })
    )
    expect(result.current).toBeNull()

    act(() =>
      setStatus({
        state: 'waiting',
        toolName: 'Bash',
        interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf dist' } })
      })
    )

    expect(result.current).toMatchObject({ kind: 'approval' })
  })

  it('gates an approval and a live question by the paused state (STA-3144)', () => {
    const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } })
    setStatus({ state: 'working', toolName: 'Bash', interactivePrompt: approval })
    const { result } = renderHook(() =>
      useNativeChatInteractivePromptCard({
        paneKey,
        messages: NO_MESSAGES,
        transcriptSettled: true
      })
    )
    expect(result.current).toBeNull()
    act(() => setStatus({ state: 'waiting', toolName: 'Bash', interactivePrompt: approval }))
    expect(result.current).toMatchObject({ kind: 'approval' })

    const ask = JSON.stringify({ questions: [{ question: 'Pick?', options: [{ label: 'A' }] }] })
    act(() => setStatus({ state: 'done', toolName: 'AskUserQuestion', interactivePrompt: ask }))
    expect(result.current).toBeNull()
  })

  it('shows an unsupported request with no options while paused', () => {
    setStatus({
      state: 'blocked',
      toolName: 'Plan',
      interactivePrompt: JSON.stringify({ choice: { title: 'Implement this plan?' } })
    })
    const { result } = renderHook(() =>
      useNativeChatInteractivePromptCard({
        paneKey,
        messages: NO_MESSAGES,
        transcriptSettled: true
      })
    )
    expect(result.current).toMatchObject({
      kind: 'unsupported',
      approval: { title: 'Implement this plan?', options: [] }
    })
  })
})
