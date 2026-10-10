// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useImperativeHandle } from 'react'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type { AskPrompt } from './native-chat-interactive-prompt'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'

// The transcript and composer are stubbed: the wire under test is which of this
// pane's sends tell the transcript to bring the latest into view.
type ComposerStubProps = { onSubmitted?: () => void }
const stubs = vi.hoisted(
  (): {
    session: NativeChatLiveSession | null
    revealLatest: () => void
    composer: ComposerStubProps | null
    cardSend: NativeChatInteractiveSend | null
  } => ({ session: null, revealLatest: vi.fn(), composer: null, cardSend: null })
)
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => stubs.session
}))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: (props: { ref?: React.Ref<NativeChatMessageListHandle> }) => {
    useImperativeHandle(props.ref, () => ({
      revealLatest: stubs.revealLatest,
      revealFindMatch: () => {}
    }))
    return null
  }
}))
vi.mock('./use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: (): NativeChatInteractiveSend => ({
    sendAnswer: () => ({ settleAfterMs: 0, waitsForVerifiedDelivery: false }),
    sendRaw: () => {},
    sendRawVerified: async () => true,
    cancelPending: () => {},
    cancelAsk: async () => true,
    cancel: () => {}
  })
}))
// A pending question, so the pane mounts its card with the send it hands it.
vi.mock('./use-native-chat-interactive-prompt-card', () => ({
  useNativeChatInteractivePromptCard: () => ({ kind: 'question', prompt })
}))
vi.mock('./NativeChatInteractiveCard', () => ({
  NativeChatInteractiveCard: (props: { send: NativeChatInteractiveSend }) => {
    stubs.cardSend = props.send
    return null
  }
}))
vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: (props: ComposerStubProps) => {
    stubs.composer = props
    return null
  }
}))

const prompt: AskPrompt = {
  questions: [{ question: 'Indent with?', multiSelect: false, options: [{ label: 'Tabs' }] }]
}

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')

afterEach(() => {
  cleanup()
  vi.mocked(stubs.revealLatest).mockReset()
  stubs.composer = null
  stubs.cardSend = null
})

describe('NativeChatResolvedView sends', () => {
  it('brings the latest into view for a composer send and a prompt answer, not a Stop', () => {
    stubs.session = {
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Rename the module' }],
          timestamp: 1,
          source: 'transcript'
        }
      ],
      status: 'ready',
      sessionId: 'session-reveal',
      agent: 'claude',
      hasMore: false,
      loadingEarlier: false,
      olderHistoryGeneration: 0,
      loadEarlier: vi.fn(),
      readPhase: 'ready'
    }
    render(
      <NativeChatResolvedView
        paneKey="tab-reveal:leaf-reveal"
        agent="claude"
        sessionId="session-reveal"
        transcriptPath={null}
        isVisible
        isFocusedGroup={false}
        targetPtyId="pty-reveal"
        terminalTabId="tab-reveal"
        ownsTabWideLaunchDraft={false}
      />
    )
    // Anti-vacuous: opening the pane reveals nothing by itself.
    expect(stubs.revealLatest).not.toHaveBeenCalled()

    stubs.composer?.onSubmitted?.()
    expect(stubs.revealLatest).toHaveBeenCalledOnce()
    // A question answer and an approval option, then Stop and a dismissal: only the answers are sends.
    stubs.cardSend?.sendAnswer(prompt, [{ indices: [0] }])
    expect(stubs.revealLatest).toHaveBeenCalledTimes(2)
    // An empty answer writes nothing, so it moves nobody.
    stubs.cardSend?.sendAnswer(prompt, [{ indices: [] }])
    expect(stubs.revealLatest).toHaveBeenCalledTimes(2)
    void stubs.cardSend?.sendRawVerified('1')
    expect(stubs.revealLatest).toHaveBeenCalledTimes(3)
    stubs.cardSend?.cancel()
    void stubs.cardSend?.cancelAsk()
    expect(stubs.revealLatest).toHaveBeenCalledTimes(3)
  })

  it('leaves the reader where they are when the terminal is gone and nothing is written', () => {
    render(
      <NativeChatResolvedView
        paneKey="tab-reveal:leaf-reveal"
        agent="claude"
        sessionId="session-reveal"
        transcriptPath={null}
        isVisible
        isFocusedGroup={false}
        targetPtyId={null}
        terminalTabId="tab-reveal"
        ownsTabWideLaunchDraft={false}
      />
    )
    stubs.cardSend?.sendAnswer(prompt, [{ indices: [0] }])
    void stubs.cardSend?.sendRawVerified('1')
    expect(stubs.cardSend).not.toBeNull()
    expect(stubs.revealLatest).not.toHaveBeenCalled()
  })
})
