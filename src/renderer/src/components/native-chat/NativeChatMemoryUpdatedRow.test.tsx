// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { botMemoryUpdatedNoteBody } from '../../../../shared/bots/bot-memory-updated-note'
import { structuredAgentSessionStatusBlock } from '../../../../shared/agent-session/view/structured-agent-session-status-block'
import { NativeChatNoticeRow } from './messages/notices/NativeChatNoticeRow'

const { openBotSettings } = vi.hoisted(() => ({ openBotSettings: vi.fn() }))
vi.mock('@/components/bots/bot-settings-open', () => ({ openBotSettings }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('keeps facts private until expanded and offers only the memory editor', () => {
  const block = structuredAgentSessionStatusBlock(
    botMemoryUpdatedNoteBody({
      botId: 'bot-1',
      added: ['Dana prefers Slack'],
      removed: ['Dana prefers calls'],
      topics: [],
      otherChanges: 0
    })
  )
  render(<NativeChatNoticeRow block={block} />)
  const disclosure = screen.getByRole('button', { name: 'Memory updated · 1 added, 1 removed' })
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Dana prefers Slack')).not.toBeInTheDocument()
  fireEvent.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('Dana prefers Slack')).toBeVisible()
  expect(screen.getByText('Removed')).toBeVisible()
  expect(screen.getByText('Dana prefers calls').tagName).toBe('S')
  expect(screen.getAllByRole('button')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Open memory' }))
  expect(openBotSettings).toHaveBeenCalledWith('bot-1', 'memory')
  fireEvent.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
})

it('shows only a safe placeholder for hidden values and names changed topic files', () => {
  render(
    <NativeChatNoticeRow
      block={structuredAgentSessionStatusBlock(
        botMemoryUpdatedNoteBody({
          botId: 'bot-1',
          added: ['password=do-not-display'],
          removed: [],
          topics: ['memory/client.md'],
          otherChanges: 0
        })
      )}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Memory updated · 1 added, 1 note changed' }))
  expect(screen.getByText('value hidden')).toBeVisible()
  expect(screen.getByText('memory/client.md')).toBeVisible()
  expect(document.body.textContent).not.toContain('do-not-display')
})
