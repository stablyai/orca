import { describe, expect, it } from 'vitest'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams,
  type WorktreeCreateRequest
} from './worktree-create-payload'

// Worker accounts (#9496): the accounts chosen in the create dialog reach the host on both transports.
describe('worktree create account pins', () => {
  const request: WorktreeCreateRequest = {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    options: { accountPins: { claude: 'claude-a' } }
  }
  const attempt = { name: 'feature' }

  it('sends the chosen accounts over IPC and to a runtime host', () => {
    expect(buildLocalWorktreeCreateArgs(request, attempt).accountPins).toEqual({
      claude: 'claude-a'
    })
    expect(buildRuntimeWorktreeCreateParams(request, attempt).accountPins).toEqual({
      claude: 'claude-a'
    })
  })

  it('sends nothing when no account was chosen', () => {
    const plain: WorktreeCreateRequest = { ...request, options: {} }
    expect('accountPins' in buildLocalWorktreeCreateArgs(plain, attempt)).toBe(false)
  })
})
