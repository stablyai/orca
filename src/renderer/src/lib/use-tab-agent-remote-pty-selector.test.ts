import { describe, expect, it, vi } from 'vitest'
import { hasRemoteRuntimePtyForTab } from './tab-agent-remote-pty-selector'

const REMOTE_PTY = 'remote:environment-1@@terminal-1'

describe('hasRemoteRuntimePtyForTab', () => {
  it('short-circuits on a tab-level remote PTY', () => {
    let leafReads = 0
    const leafPtyIdsById = new Proxy(
      { leaf: REMOTE_PTY },
      {
        ownKeys: () => {
          leafReads += 1
          return ['leaf']
        }
      }
    )

    expect(hasRemoteRuntimePtyForTab([REMOTE_PTY], leafPtyIdsById)).toBe(true)
    expect(leafReads).toBe(0)
  })

  it('finds a remote PTY that is present only in the layout projection', () => {
    expect(
      hasRemoteRuntimePtyForTab(['local-pty'], { first: 'local-pty', second: REMOTE_PTY })
    ).toBe(true)
  })

  it('ignores inherited layout properties like Object.values did', () => {
    const inherited = { inherited: REMOTE_PTY }
    const leafPtyIdsById = Object.create(inherited) as Record<string, string>
    leafPtyIdsById.local = 'local-pty'

    expect(hasRemoteRuntimePtyForTab(['local-pty'], leafPtyIdsById)).toBe(false)
  })

  it('avoids transient Set and Object.values allocations across repeated checks', () => {
    const originalSet = globalThis.Set
    const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(() => {
      throw new Error('unexpected Object.values allocation')
    })
    vi.stubGlobal(
      'Set',
      class UnexpectedSet {
        constructor() {
          throw new Error('unexpected Set allocation')
        }
      }
    )

    try {
      for (let check = 0; check < 1_000; check += 1) {
        expect(hasRemoteRuntimePtyForTab(['local-pty'], { first: 'local-pty-2' })).toBe(false)
      }
    } finally {
      valuesSpy.mockRestore()
      vi.stubGlobal('Set', originalSet)
    }
  })
})
