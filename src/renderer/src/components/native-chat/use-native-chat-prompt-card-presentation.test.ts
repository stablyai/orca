// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../store'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import {
  nativeChatPromptDismissals,
  forgetNativeChatPromptDismissalsForTab
} from './native-chat-prompt-dismissals'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'

const PANE = 'tab-1:leaf-1'
const question: InteractivePromptCard = {
  kind: 'question',
  prompt: {
    questions: [{ question: 'Which folder?', multiSelect: false, options: [{ label: 'build' }] }]
  }
}

function renderPresentation(card: InteractivePromptCard = question) {
  return renderHook(
    (props: { card: InteractivePromptCard }) =>
      useNativeChatPromptCardPresentation({
        paneKey: PANE,
        targetPtyId: 'pty-1',
        card: props.card,
        canSend: true
      }),
    { initialProps: { card } }
  )
}

function waitFromStatus(stateStartedAt: number): void {
  useAppStore
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'waiting', prompt: '', agentType: 'claude', interactivePrompt: '{}' },
      undefined,
      { stateStartedAt }
    )
}

beforeEach(() => {
  nativeChatPromptDismissals.clearForTests()
  useAppStore.setState({ agentStatusByPaneKey: {} })
})

describe('dismissed prompt occurrences outlive the view but not the prompt', () => {
  it('keeps a status-backed answer hidden for a remounted view', () => {
    waitFromStatus(10)
    const first = renderPresentation()
    act(() => first.result.current.dismiss())
    expect(first.result.current.card).toBeNull()
    first.unmount()

    expect(renderPresentation().result.current.card).toBeNull()
  })

  it('re-shows a transcript-only question after the view stops observing it', () => {
    const first = renderPresentation()
    act(() => first.result.current.collapse())
    expect(first.result.current.collapsedCard).toBe(question)
    first.unmount()

    expect(renderPresentation().result.current.card).toBe(question)
  })

  it('shows an identical question again once the prompt cleared', () => {
    const view = renderPresentation()
    act(() => view.result.current.dismiss())
    view.rerender({ card: null })
    view.rerender({ card: question })
    expect(view.result.current.card).toBe(question)
  })

  it('forgets the dismissal when its tab retires', () => {
    waitFromStatus(10)
    const first = renderPresentation()
    act(() => first.result.current.collapse())
    first.unmount()
    forgetNativeChatPromptDismissalsForTab('tab-1')

    expect(renderPresentation().result.current.card).toBe(question)
  })
})
