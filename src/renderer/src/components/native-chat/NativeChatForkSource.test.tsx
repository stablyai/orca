// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ open: vi.fn(async () => true) }))
vi.mock('./structured-agent-session-status-hooks', () => ({
  useStructuredAgentSessionStatusSummary: () => ({
    summary: { forkedFrom: { sessionId: 'closed-parent', itemId: 'answer-B' } }
  })
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.open
}))
import { NativeChatForkSource } from './NativeChatForkSource'
afterEach(cleanup)
it('keeps the source link without a parent tab and uses the execution host reveal route', async () => {
  const target = { kind: 'environment', environmentId: 'remote' } as const
  render(<NativeChatForkSource sessionId="child" worktreeId="folder:workspace" target={target} />)
  fireEvent.click(screen.getByRole('button', { name: 'Forked from parent chat' }))
  await waitFor(() =>
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(
      {
        structuredSession: { workspaceId: 'folder:workspace', sessionId: 'closed-parent' }
      },
      undefined,
      target
    )
  )
})
