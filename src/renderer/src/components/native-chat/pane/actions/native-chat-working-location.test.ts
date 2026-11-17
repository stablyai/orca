import { describe, expect, it } from 'vitest'
import { resolveNativeChatWorkingLocation } from './native-chat-working-location'

const chatWorktree = { path: '/repo', hostId: undefined }

function row(path: string, branch: string) {
  return {
    id: `repo::${path}`,
    repoId: 'repo',
    hostId: 'local' as const,
    path,
    displayName: '',
    branch
  }
}

const worktrees = { repo: [row('/repo', 'refs/heads/main'), row('/repo/feature', 'feature')] }
const detectedWorktrees = {
  repo: {
    worktrees: [
      { ...row('/repo/feature', 'feature'), visible: true },
      { ...row('/repo/.claude/worktrees/fix', 'refs/heads/fix'), visible: false }
    ]
  }
}

function resolve(workingDirectory: string | undefined, hostId?: 'ssh:box') {
  return resolveNativeChatWorkingLocation({
    workingDirectory,
    chatWorktree: { ...chatWorktree, hostId },
    worktrees,
    detectedWorktrees
  })
}

describe('resolveNativeChatWorkingLocation', () => {
  it('says nothing while the agent works in the chat workspace', () => {
    expect(resolve(undefined)).toBeNull()
    expect(resolve('/repo/')).toBeNull()
  })

  it('names the Orca worktree the agent moved into, hidden or not', () => {
    expect(resolve('/repo/feature')).toMatchObject({
      kind: 'worktree',
      worktreeId: 'repo::/repo/feature',
      displayName: 'feature',
      branch: 'feature',
      hidden: false
    })
    expect(resolve('/repo/.claude/worktrees/fix')).toMatchObject({
      kind: 'worktree',
      branch: 'fix',
      hidden: true
    })
  })

  it('falls back to a plain folder for unknown paths and other hosts', () => {
    expect(resolve('/scratch/notes')).toEqual({
      kind: 'folder',
      path: '/scratch/notes',
      displayName: 'notes'
    })
    expect(resolve('/repo/feature', 'ssh:box')).toEqual({
      kind: 'folder',
      path: '/repo/feature',
      displayName: 'feature'
    })
  })
})
