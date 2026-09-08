import { describe, expect, it } from 'vitest'
import { repoIsRemote } from './agent-launch-remote'

describe('repoIsRemote', () => {
  it('reads both spellings of SSH ownership on two different hosts', () => {
    // Why two hosts: a single-host fixture passes even when the predicate answers from the wrong
    // row, which is how the `ssh:m4air` -> openclaw leak survived review.
    expect(repoIsRemote({ connectionId: 'm4air', executionHostId: null })).toBe(true)
    expect(repoIsRemote({ connectionId: null, executionHostId: 'ssh:openclaw' })).toBe(true)
    expect(repoIsRemote({ connectionId: 'm4air', executionHostId: 'ssh:m4air' })).toBe(true)
  })

  it('answers local for a row that declares itself local with a stale connection', () => {
    expect(repoIsRemote({ connectionId: 'm4air', executionHostId: 'local' })).toBe(false)
  })

  it('keeps a runtime host with a nested SSH target remote', () => {
    expect(repoIsRemote({ connectionId: 'nested-target', executionHostId: 'runtime:vm-1' })).toBe(
      true
    )
  })

  it('keeps a runtime host with no nested SSH target local-shaped', () => {
    // A runtime with no nested target is a full Orca install, not a relay shim, so it keeps the
    // platform CLI name.
    expect(repoIsRemote({ connectionId: null, executionHostId: 'runtime:vm-1' })).toBe(false)
  })

  it('keeps plain local and WSL rows local', () => {
    expect(repoIsRemote({ connectionId: null, executionHostId: null })).toBe(false)
    expect(repoIsRemote({ connectionId: null, executionHostId: 'local' })).toBe(false)
  })
})
