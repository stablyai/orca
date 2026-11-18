// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

const scout = vi.hoisted(() => ({ folderWorkspaceId: 'fw-scout' }))
vi.mock('@/lib/bot-catalog', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only the bot's home id.
  const bots = [{ id: 'b1', folderWorkspaceId: scout.folderWorkspaceId } as Bot]
  return {
    useBots: (enabled = true) => (enabled ? bots : []),
    readBots: () => bots,
    useBotsEnabled: () => true,
    readBotsEnabled: () => true
  }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from './messages/rows/NativeChatMessageRow'
import { NativeChatVisualOwnerContext } from './media/visuals/native-chat-visual-owner'

afterEach(cleanup)

const owner = (worktreeId: string) => ({
  target: { kind: 'local' as const },
  sessionId: 's1',
  worktreeId
})
const BOT_HOME = owner(folderWorkspaceKey('fw-scout'))
const OTHER = owner(folderWorkspaceKey('fw-other'))

function renderAnswer(
  text: string,
  chat: ReturnType<typeof owner>,
  inAutomationTurn = false
): void {
  render(
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={chat}>
        <MessageRow
          message={{
            id: 'answer',
            role: 'assistant',
            timestamp: 0,
            source: 'transcript',
            blocks: [{ type: 'text', text }]
          }}
          expandSignal={false}
          inAutomationTurn={inAutomationTurn}
          onScrollMessageToTop={vi.fn()}
        />
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}

describe('a bot’s quiet result in its home chat', () => {
  it('reads as Nothing to report instead of the marker', () => {
    renderAnswer('NO_REPLY', BOT_HOME)
    expect(screen.getByText('Nothing to report')).toBeInTheDocument()
    expect(screen.queryByText(/NO_REPLY/)).toBeNull()
  })

  it('keeps what came before the marker', () => {
    renderAnswer('Checked the inbox; nothing new.\n\nNO_REPLY\n', BOT_HOME)
    expect(screen.getByText('Checked the inbox; nothing new.')).toBeInTheDocument()
    expect(screen.getByText('Nothing to report')).toBeInTheDocument()
    expect(screen.queryByText(/NO_REPLY/)).toBeNull()
  })

  it('leaves a marker that is not at the end as written', () => {
    renderAnswer('NO_REPLY is the quiet word', BOT_HOME)
    expect(screen.getByText('NO_REPLY is the quiet word')).toBeInTheDocument()
    expect(screen.queryByText('Nothing to report')).toBeNull()
  })

  it('draws no line under the automation row that opened its turn', () => {
    renderAnswer('NO_REPLY', BOT_HOME, true)
    expect(screen.queryByText('Nothing to report')).toBeNull()
    expect(screen.queryByText(/NO_REPLY/)).toBeNull()
  })

  it('leaves any other chat’s message as written', () => {
    renderAnswer('NO_REPLY', OTHER)
    expect(screen.getByText('NO_REPLY')).toBeInTheDocument()
    expect(screen.queryByText('Nothing to report')).toBeNull()
  })
})
