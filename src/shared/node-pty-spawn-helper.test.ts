import { describe, expect, it } from 'vitest'
import { usesNodePtySpawnHelper } from './node-pty-spawn-helper'

describe('usesNodePtySpawnHelper', () => {
  it('is macOS only', () => {
    // binding.gyp builds spawn-helper only for macOS; requiring it on all non-Windows hosts broke healthy Linux (#17844).
    expect(usesNodePtySpawnHelper('darwin')).toBe(true)
    for (const platform of ['linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix']) {
      expect(usesNodePtySpawnHelper(platform)).toBe(false)
    }
  })
})
