// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { botContextNoteBody } from '../../../../shared/bots/bot-context-note'
import { structuredAgentSessionStatusBlock } from '../../../../shared/agent-session/view/structured-agent-session-status-block'
import { NativeChatNoticeRow } from './messages/notices/NativeChatNoticeRow'

const { openBotSettings } = vi.hoisted(() => ({ openBotSettings: vi.fn() }))
vi.mock('@/components/bots/bot-settings-open', () => ({ openBotSettings }))

afterEach(cleanup)

it('names what a turn carried, never its text, and opens the bot settings', () => {
  const block = structuredAgentSessionStatusBlock(
    botContextNoteBody({ botId: 'bot-1', changed: ['soul', 'memory'] })
  )
  render(<NativeChatNoticeRow block={block} />)

  const row = screen.getByRole('button', {
    name: 'Updated soul applied · Memory edited outside this chat'
  })
  fireEvent.click(row)
  expect(openBotSettings).toHaveBeenCalledWith('bot-1', undefined)
})

it('opens the one file a turn changed', () => {
  const block = structuredAgentSessionStatusBlock(
    botContextNoteBody({ botId: 'bot-1', changed: ['memory'] })
  )
  render(<NativeChatNoticeRow block={block} />)
  fireEvent.click(screen.getByRole('button', { name: 'Memory edited outside this chat' }))
  expect(openBotSettings).toHaveBeenCalledWith('bot-1', 'memory')
})
