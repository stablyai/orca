import { expect, it } from 'vitest'
import { resolveAgentStatusWorktreeId } from './agent-status-worktree-attribution'

it('attributes a chat to its own workspace when another workspace’s tab id equals its address', () => {
  // W1's tab kept conversation A's address as its id after its chat was replaced; W2 shows A.
  const worktreeIdByTabId = new Map([['structured-agent-session-sess-2', 'W1']])
  expect(
    resolveAgentStatusWorktreeId(
      {
        paneKey: 'structured-agent-session-sess-2:2b8ea975-8113-41ae-a25c-feb50cbe084a',
        worktreeId: 'W2',
        orchestration: undefined,
        connectionId: undefined
      },
      worktreeIdByTabId
    )
  ).toBe('W2')
})
