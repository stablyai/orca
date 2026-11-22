// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotShareReview } from '../../../../../shared/bots/bot-share-received'

import { BotShareReviewDialog } from './BotShareReviewDialog'

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

afterEach(cleanup)

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
