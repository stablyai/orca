import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'

describe('terminal provider snapshot capabilities', () => {
  beforeEach(() => clearTerminalProviderSnapshotCapabilities())

  it('records current and legacy daemon capabilities from one batch', () => {
    const resolve = vi.fn(() => [
      { id: 'current', authoritative: true },
      { id: 'legacy', authoritative: false }
    ])

    synchronizeTerminalProviderSnapshotCapabilities(['current', 'legacy'], resolve)

    expect(resolve).toHaveBeenCalledWith(['current', 'legacy'])
    expect(terminalProviderHasAuthoritativeSnapshot('current')).toBe(true)
    expect(terminalProviderHasAuthoritativeSnapshot('legacy')).toBe(false)
  })

  it('caches resolved PTYs and prunes closed ones', () => {
    const resolve = vi.fn((ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true as boolean | null }))
    )

    synchronizeTerminalProviderSnapshotCapabilities(['pty-1', 'pty-2'], resolve)
    synchronizeTerminalProviderSnapshotCapabilities(['pty-2', 'pty-3'], resolve)

    expect(resolve).toHaveBeenNthCalledWith(1, ['pty-1', 'pty-2'])
    expect(resolve).toHaveBeenNthCalledWith(2, ['pty-3'])
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(false)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-2')).toBe(true)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-3')).toBe(true)
  })

  it('retries capabilities that are still unknown during daemon startup', () => {
    const resolve = vi
      .fn()
      .mockReturnValueOnce([{ id: 'pty-1', authoritative: null }])
      .mockReturnValueOnce([{ id: 'pty-1', authoritative: true }])

    synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], resolve, 1_000)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(false)
    synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], resolve, 1_999)
    expect(resolve).toHaveBeenCalledOnce()
    synchronizeTerminalProviderSnapshotCapabilities(['pty-1'], resolve, 2_000)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(terminalProviderHasAuthoritativeSnapshot('pty-1')).toBe(true)
  })
})
