// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoundClaudeHomeUsage } from '../../../../shared/rate-limit-types'
import { BoundClaudeHomesSection } from './BoundClaudeHomesSection'

vi.mock('./InlineProviderUsage', () => ({
  InlineUsageBars: () => <div data-testid="usage-bars" />,
  InlineUsageSkeleton: () => <div data-testid="usage-skeleton" />
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>
}))

function usageRow(overrides: Partial<BoundClaudeHomeUsage> = {}): BoundClaudeHomeUsage {
  return {
    groupId: 'group-a',
    configDir: '/Users/dana/.claude-work',
    rateLimits: null,
    status: 'ok',
    updatedAt: 0,
    isFetching: false,
    ...overrides
  }
}

const groups = [{ id: 'group-a', name: 'Work' }]

afterEach(() => {
  cleanup()
})

describe('BoundClaudeHomesSection', () => {
  it('renders nothing when a host sends no bound-home array at all', () => {
    const { container } = render(<BoundClaudeHomesSection rows={undefined} groups={groups} />)

    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when no group is bound', () => {
    const { container } = render(<BoundClaudeHomesSection rows={[]} groups={groups} />)

    expect(container.innerHTML).toBe('')
  })

  it('renders usage bars for a readable directory', () => {
    render(
      <BoundClaudeHomesSection
        rows={[
          usageRow({
            status: 'ok',
            rateLimits: {
              provider: 'claude',
              session: {
                usedPercent: 40,
                windowMinutes: 300,
                resetsAt: null,
                resetDescription: null
              },
              weekly: null,
              updatedAt: 1,
              error: null,
              status: 'ok'
            }
          })
        ]}
        groups={groups}
      />
    )

    expect(screen.getByText('Bound groups')).toBeTruthy()
    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.getByTestId('usage-bars')).toBeTruthy()
  })

  it.each([
    ['signed-out', 'Signed out'],
    ['expired', 'Session expired'],
    ['unreadable', 'Directory unreadable'],
    ['unavailable', 'Usage unavailable']
  ] as const)('renders a muted status line instead of bars for %s', (status, label) => {
    render(<BoundClaudeHomesSection rows={[usageRow({ status })]} groups={groups} />)

    const line = screen.getByText(label)
    expect(line.className).toContain('text-muted-foreground')
    expect(screen.queryByTestId('usage-bars')).toBeNull()
  })

  it('falls back to the bound directory when the group name is unknown', () => {
    render(<BoundClaudeHomesSection rows={[usageRow({ groupId: 'gone' })]} groups={groups} />)

    expect(screen.getByText('/Users/dana/.claude-work')).toBeTruthy()
  })

  it('shows a skeleton while a row is still fetching', () => {
    render(<BoundClaudeHomesSection rows={[usageRow({ isFetching: true })]} groups={groups} />)

    expect(screen.getByTestId('usage-skeleton')).toBeTruthy()
  })
})
