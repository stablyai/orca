// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ScheduledMessage } from '../../../../shared/scheduled-message-types'
import { ScheduledMessagesSection } from './ScheduledMessagesSection'

const messages: ScheduledMessage[] = [
  {
    id: 'm1',
    worktreeId: 'wt-1',
    text: 'Rebase onto main.',
    timing: { kind: 'at', sendAt: 1_000 },
    createdAt: 0,
    status: 'missed',
    failureReason: 'expired-while-closed'
  }
]

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (s: { scheduledMessages: ScheduledMessage[] }) => unknown) =>
    selector({ scheduledMessages: messages })
}))
vi.mock('@/store/selectors', () => ({
  useWorktreeMap: () => new Map([['wt-1', { displayName: 'feature' }]])
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

afterEach(cleanup)

describe('ScheduledMessagesSection', () => {
  it('lets a long failure reason widen its column instead of truncating at w-52', () => {
    render(
      <TooltipProvider>
        <ScheduledMessagesSection relativeNow={2_000} />
      </TooltipProvider>
    )
    const status = screen.getByText('Missed — Orca was closed when it came due')

    expect(status.className.split(/\s+/)).not.toContain('w-52')
    expect(status.className.split(/\s+/)).toContain('min-w-52')
  })
})
