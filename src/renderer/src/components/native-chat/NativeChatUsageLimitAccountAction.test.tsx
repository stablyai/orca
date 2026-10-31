// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session-journal-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from './NativeChatMessageRow'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import type { NativeChatUsageLimitAccountOffer } from './use-native-chat-usage-limit-account-offer'

afterEach(() => {
  cleanup()
})

const LIMIT_ROW: AgentJournalStatusItem = {
  kind: 'status',
  tone: 'warning',
  ...agentSessionFailureWords(
    agentSessionFailureFact('usageLimitReached', { usageLimit: { window: 'weekly' } }),
    { agentName: 'Codex', surface: 'row' }
  )
}

function limitView(
  offer: NativeChatUsageLimitAccountOffer | null,
  offeredTurn: string
): NativeChatOrcaStopView {
  return {
    hostLabel: null,
    remoteHost: false,
    continueAvailable: true,
    offeredTurnItemId: null,
    continueNow: () => {},
    usageLimitTurnItemId: offeredTurn,
    continueUsageLimit: () => {},
    usageLimitAccountOffer: offer
  }
}

function renderLimit(offer: NativeChatUsageLimitAccountOffer | null, offeredTurn = 'cut-turn') {
  const [message] = projectStructuredItemsToNativeChat([
    {
      itemId: 'limit',
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body: LIMIT_ROW,
      turnScope: { kind: 'turn', turnItemId: 'cut-turn' }
    }
  ])
  const view = limitView(offer, offeredTurn)
  return render(
    <TooltipProvider>
      <NativeChatOrcaStopContext.Provider value={view}>
        <MessageRow
          message={message!}
          agentName="Codex"
          expandSignal={false}
          onScrollMessageToTop={vi.fn()}
        />
      </NativeChatOrcaStopContext.Provider>
    </TooltipProvider>
  )
}

it('offers the other account with room, and one click switches and continues', () => {
  const switchAndContinue = vi.fn()
  renderLimit({
    kind: 'switch',
    account: 'b@example.com',
    percentLeft: 74,
    switching: false,
    switchAndContinue
  })
  expect(screen.getByText(/Codex hit its weekly limit/)).toBeInTheDocument()
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to b@example.com · 74% left and continue' })
  )
  expect(switchAndContinue).toHaveBeenCalledTimes(1)
})

it('offers Add account when the agent has no other account', () => {
  const addAccount = vi.fn()
  renderLimit({ kind: 'add', agent: 'codex', addAccount })
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
  expect(addAccount).toHaveBeenCalledTimes(1)
})

it('offers nothing on an older limit, or when no account has room', () => {
  renderLimit({ kind: 'add', agent: 'codex', addAccount: vi.fn() }, 'newer-turn')
  expect(screen.queryByRole('button')).toBeNull()
  cleanup()
  renderLimit(null)
  expect(screen.queryByRole('button')).toBeNull()
})
