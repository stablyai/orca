import { describe, expect, it } from 'vitest'
import { pickWorkspaceWorktree } from './workspace-worktree-pick'

const base = { id: 'r::/vercel/sandbox/project', branch: 'refs/heads/master', isMainWorktree: true }
const own = {
  id: 'r::/home/ubuntu/orca/workspaces/Hello-World/endpass-n44',
  branch: 'refs/heads/endpass-n44',
  isMainWorktree: false
}
const other = {
  id: 'r::/home/ubuntu/orca/workspaces/Hello-World/scratch',
  branch: 'scratch',
  isMainWorktree: false
}

describe('pickWorkspaceWorktree (EP-6)', () => {
  it("opens a shared workspace on its own worktree, not the sandbox's base checkout", () => {
    expect(pickWorkspaceWorktree([base, own], 'endpass-n44')).toBe(own.id)
    expect(pickWorkspaceWorktree([base, other, own], 'refs/heads/endpass-n44')).toBe(own.id)
  })

  it('without a known branch, still prefers a linked worktree over the base checkout', () => {
    expect(pickWorkspaceWorktree([base, own], null)).toBe(own.id)
    expect(pickWorkspaceWorktree([base, own], 'gone-branch')).toBe(own.id)
  })

  it('a GitHub-only workspace (only the primary) opens its primary; nothing listed yet is null', () => {
    expect(pickWorkspaceWorktree([base], 'master')).toBe(base.id)
    expect(pickWorkspaceWorktree([base], null)).toBe(base.id)
    expect(pickWorkspaceWorktree([], 'x')).toBeNull()
  })
})
