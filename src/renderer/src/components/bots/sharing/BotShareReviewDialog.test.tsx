// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BotShareReview } from '../../../../../shared/bots/bot-share-received'

const calls = vi.hoisted(() => {
  const rpc: { method: string; params: unknown }[] = []
  return { rpc }
})

// The runtime boundary: every call is recorded and succeeds.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_host: unknown, method: string, params: unknown) => {
    calls.rpc.push({ method, params })
    return { reported: true }
  }
}))
vi.mock('@/lib/bot-catalog', () => ({
  createBot: vi.fn(),
  useHostBots: () => [],
  uploadBotAvatar: vi.fn(),
  openBotHomeTab: vi.fn(async () => true),
  readBotAvatarPng: vi.fn(async () => null)
}))
vi.mock('../use-bot-agent-choices', () => ({
  useBotAgentMenu: () => ({ model: { state: 'loading' }, choices: ['claude'] })
}))
vi.mock('../BotAgentLaunchPicker', () => ({ BotAgentLaunchPicker: () => null }))

import { BotShareReviewDialog } from './BotShareReviewDialog'
import { NewBotFromShareDialog } from './NewBotFromShareDialog'

const review: BotShareReview = {
  reviewId: '7d1f0c2a-4b5e-4c6d-8e9f-0a1b2c3d4e5f',
  shareId: 'share-1',
  versionId: 'version-reviewed',
  publisher: 'Dara',
  publishedAt: '2026-11-08T00:00:00.000Z',
  bot: {
    schemaVersion: 1,
    name: 'Release notes',
    purpose: 'Drafts release notes.',
    agentHint: 'claude',
    skills: [],
    tools: [],
    connectors: [],
    schedules: [],
    eventSuggestions: [],
    memory: []
  },
  files: [{ path: 'SOUL.md', text: '# Release notes\n', flags: [] }],
  flags: [],
  leftOut: [],
  avatarDataUrl: null
}

afterEach(() => {
  cleanup()
  calls.rpc.length = 0
})

// Plugin themes restyle every dialog but the protected one: a stranger's bot is a trust decision.
const PROTECTED_SURFACE = 'plugin-security-chrome'

it('makes the bot on the protected surface', () => {
  render(
    <TooltipProvider>
      <NewBotFromShareDialog
        review={review}
        toolIds={[]}
        onToolIdsChange={vi.fn()}
        onBack={vi.fn()}
        onMoved={vi.fn()}
        onClose={vi.fn()}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('dialog', { name: 'New bot' }).classList).toContain(PROTECTED_SURFACE)
})

it("shows a copy's original with nothing to change on any page", () => {
  const withTool: BotShareReview = {
    ...review,
    bot: {
      ...review.bot,
      tools: [
        {
          id: 't1',
          name: 'docs-search',
          url: 'https://mcp.docsearch.example.com/mcp',
          headerNames: []
        }
      ]
    }
  }
  render(<BotShareReviewDialog review={withTool} readOnly onClose={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: /Tools/ }))
  expect(screen.getByText('docs-search')).toBeTruthy()
  expect(screen.queryAllByRole('checkbox')).toEqual([])
  expect(screen.queryByRole('button', { name: 'Create bot…' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
})
