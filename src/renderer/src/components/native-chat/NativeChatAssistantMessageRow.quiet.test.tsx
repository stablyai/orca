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
  turn: { inAutomationTurn?: boolean; inActingTurn?: boolean } = {},
  live = false
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
          {...turn}
          activeTurnIsWorking={live}
          trailingRun={live}
          onScrollMessageToTop={vi.fn()}
        />
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}

describe('a bot’s quiet result in its home chat', () => {
  it('draws no caption when its turn did something others see', () => {
    renderAnswer('NO_REPLY', BOT_HOME, { inActingTurn: true })
    expect(screen.queryByText('Nothing to report')).toBeNull()
    expect(screen.queryByText(/NO_REPLY/)).toBeNull()
  })

  it('draws no line under the automation row that opened its turn', () => {
    renderAnswer('NO_REPLY', BOT_HOME, { inAutomationTurn: true })
    expect(screen.queryByText('Nothing to report')).toBeNull()
    expect(screen.queryByText(/NO_REPLY/)).toBeNull()
  })

  it('never draws the marker while the row still reads as live', () => {
    renderAnswer('Checked the inbox.\n\nNO_REP', BOT_HOME, {}, true)
    expect(screen.getByText('Checked the inbox.')).toBeInTheDocument()
    expect(screen.queryByText(/NO_REP/)).toBeNull()
  })

  it('leaves any other chat’s message as written', () => {
    renderAnswer('NO_REPLY', OTHER)
    expect(screen.getByText('NO_REPLY')).toBeInTheDocument()
    expect(screen.queryByText('Nothing to report')).toBeNull()
  })
})
