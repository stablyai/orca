import { expect, it } from 'vitest'
import { withAgentWorktreePolicy } from './agent-worktree-policy'

it('preserves an already prepared task when a second host receives it', () => {
  const prompt =
    '<orca-worktree-policy version="1">\nExisting instructions\n</orca-worktree-policy>\n\nFix this bug'
  expect(withAgentWorktreePolicy(prompt, { baseline: 'origin/other' })).toBe(
    '<orca-worktree-policy version="1">\nExisting instructions\n</orca-worktree-policy>\n\nFix this bug'
  )
})
