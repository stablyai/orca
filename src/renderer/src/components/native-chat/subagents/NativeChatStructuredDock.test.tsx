// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const feed = vi.hoisted((): { approvals: unknown[] } => ({ approvals: [] }))
vi.mock('../worker-approvals/native-chat-worker-approval-feed', () => ({
  useNativeChatPinnedWorkerApprovals: () => feed.approvals
}))
vi.mock('../../orchestration-crew/use-native-chat-crew', async () => {
  const { createContext } = await import('react')
  return { NativeChatCrewContext: createContext(null), useNativeChatCrew: () => null }
})
vi.mock('../worker-approvals/NativeChatWorkerApprovals', () => ({
  NativeChatWorkerApprovalStack: ({ approvals }: { approvals: unknown[] }) => (
    <div data-testid="approvals">{approvals.length}</div>
  )
}))
const { NativeChatStructuredDock } = await import('./NativeChatStructuredDock')
afterEach(cleanup)

const dock = () => (
  <NativeChatStructuredDock
    part="approvals"
    hasWork={false}
    strip={<div data-testid="strip" />}
    target={{ kind: 'local' }}
    party="orca_session_id:11111111-1111-4111-8111-111111111111"
    isVisible
  />
)

it('shows a worker prompt in a chat with no listed work, and nothing without one', () => {
  feed.approvals = []
  const { rerender, container } = render(dock())
  expect(container).toBeEmptyDOMElement()
  // A remote host without dock presence, or a cold start, still has the worker's open prompt.
  feed.approvals = [{ approval: { approvalId: 'apr_1', state: 'open' } }]
  rerender(dock())
  expect(screen.getByTestId('approvals')).toHaveTextContent('1')
  expect(screen.queryByTestId('strip')).toBeNull()
})
