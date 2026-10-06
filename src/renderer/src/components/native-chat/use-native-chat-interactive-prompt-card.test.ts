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
})
