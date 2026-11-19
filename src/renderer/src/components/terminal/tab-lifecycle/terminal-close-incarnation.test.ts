import { describe, expect, it } from 'vitest'
import { getTerminalIncarnationHandle } from './terminal-close-incarnation'

describe('terminal close incarnation', () => {
  it('selects only a terminal handle owned by the target runtime environment', () => {
    expect(getTerminalIncarnationHandle('remote:target-env@@target-terminal', 'target-env')).toBe(
      'target-terminal'
    )
    expect(
      getTerminalIncarnationHandle('remote:other-env@@other-terminal', 'target-env')
    ).toBeNull()
  })

  it('does not reinterpret native, WSL, or SSH identities as runtime authority', () => {
    for (const ptyId of [
      'remote:legacy-unscoped-handle',
      'native-pty',
      'wsl:Ubuntu:pty-1',
      'ssh:host:pty-2'
    ]) {
      expect(getTerminalIncarnationHandle(ptyId, 'target-env')).toBeNull()
    }
  })
})
