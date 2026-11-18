// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from '@/components/native-chat/messages/rows/NativeChatMessageRow'
import { NativeChatHostSetupContext } from '../../host-access/native-chat-host-setup'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { projectStructuredItemsToNativeChat } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { agentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { latestNativeChatSucceededTurn } from '../../../../../../shared/native-chat/transcript/turns/native-chat-setup-failure-resolution'

afterEach(cleanup)

// A turn's record opens it, so its failure row follows at the next sequence.
function signInFailure(itemId: string, turnSequence: number): AgentJournalRenderItem {
  return {
    itemId,
    sequence: turnSequence + 1,
    revision: 1,
    observedAt: turnSequence + 1,
    turnScope: { kind: 'turn', turnItemId: `turn-${turnSequence}` },
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'row' })
    }
  }
}

function turn(sequence: number, outcome: 'success' | 'failure'): AgentJournalRenderItem {
  return {
    itemId: `turn-${sequence}`,
    sequence,
    revision: 2,
    observedAt: sequence,
    body: { kind: 'turn', turnId: `t-${sequence}`, state: 'completed', outcome }
  }
}

const setupFor = (items: AgentJournalRenderItem[]) => ({
  signIn: { signingIn: false, signIn: () => {}, loginCommand: 'pi' },
  install: null,
  latestSucceededTurn: latestNativeChatSucceededTurn(items)
})

function renderTranscript(items: AgentJournalRenderItem[]) {
  const setup = setupFor(items)
  render(
    <TooltipProvider>
      <NativeChatHostSetupContext.Provider value={setup}>
        {projectStructuredItemsToNativeChat(items).map((message) => (
          <div key={message.id} data-testid={message.id}>
            <MessageRow message={message} expandSignal={false} onScrollMessageToTop={vi.fn()} />
          </div>
        ))}
      </NativeChatHostSetupContext.Provider>
    </TooltipProvider>,
    { wrapper: TranslationScopeProvider }
  )
}

const signInButtonsIn = (id: string) =>
  within(screen.getByTestId(id)).queryAllByRole('button', { name: 'Sign in' })
const isRedIn = (id: string) => screen.getByTestId(id).querySelector('.text-destructive') !== null

describe('transcript sign-in failures', () => {
  it('mutes failures a later successful turn resolved and drops their Sign in, keeping newer ones', () => {
    renderTranscript([
      turn(1, 'failure'),
      signInFailure('first', 1),
      turn(3, 'failure'),
      signInFailure('second', 3),
      turn(5, 'success'),
      turn(6, 'failure'),
      signInFailure('later', 6)
    ])

    expect(signInButtonsIn('first')).toHaveLength(0)
    expect(signInButtonsIn('second')).toHaveLength(0)
    expect(signInButtonsIn('later')).toHaveLength(1)
    expect([isRedIn('first'), isRedIn('second'), isRedIn('later')]).toEqual([false, false, true])
  })

  it('keeps Sign in on every failure while no turn has succeeded', () => {
    renderTranscript([
      turn(1, 'failure'),
      signInFailure('first', 1),
      turn(3, 'failure'),
      signInFailure('second', 3)
    ])

    expect(signInButtonsIn('first')).toHaveLength(1)
    expect(signInButtonsIn('second')).toHaveLength(1)
    expect([isRedIn('first'), isRedIn('second')]).toEqual([true, true])
  })
})
