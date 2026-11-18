// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotRowLineView } from './BotRowActivityLine'

vi.mock('@/store', () => ({ useAppStore: () => null }))
vi.mock('@/lib/bot-catalog', () => ({
  useBotWaits: () => [],
  useListedBotItemsNeedingOwner: () => null
}))

afterEach(cleanup)

const NOW = 10 * 60 * 60_000
const ACTIVITY = {
  kind: 'activity',
  place: null,
  text: 'I posted the message to Bob',
  at: NOW - 3 * 60 * 60_000
} as const

describe('BotRowLineView', () => {
  it('ends with the fold toggle, not the time', () => {
    render(
      <BotRowLineView
        line={ACTIVITY}
        unread={false}
        now={NOW}
        trailing={<button type="button">fold</button>}
      />
    )
    const text = screen.getByText('I posted the message to Bob')
    const toggle = screen.getByRole('button', { name: 'fold' })
    expect(text.parentElement?.lastElementChild).toBe(toggle)
    expect(screen.queryByText('3h')).toBeNull()
  })

  it('keeps the fold toggle when there is nothing to say', () => {
    render(
      <BotRowLineView
        line={null}
        unread={false}
        now={NOW}
        trailing={<button type="button">fold</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'fold' })).toBeInTheDocument()
  })

  it('gives its purpose back to new activity', () => {
    const { rerender } = render(
      <BotRowLineView line={null} fallback="Runs the team's week" unread={false} now={NOW} />
    )
    expect(screen.getByText("Runs the team's week")).toBeInTheDocument()
    rerender(
      <BotRowLineView line={ACTIVITY} fallback="Runs the team's week" unread={false} now={NOW} />
    )
    expect(screen.getByText('I posted the message to Bob')).toBeInTheDocument()
    expect(screen.queryByText("Runs the team's week")).toBeNull()
  })
})
