import { describe, expect, it } from 'vitest'
import { repoIsRemote } from './agent-launch-remote'

describe('repoIsRemote', () => {
  it('treats SSH execution hosts as remote launch hosts', () => {
    expect(repoIsRemote({ connectionId: null, executionHostId: 'ssh:ssh-1' })).toBe(true)
    expect(repoIsRemote({ connectionId: 'ssh-1', executionHostId: null })).toBe(true)
    expect(repoIsRemote({ connectionId: null, executionHostId: 'runtime:env-1' })).toBe(false)
    expect(repoIsRemote({ connectionId: null, executionHostId: 'local' })).toBe(false)
  })
})
