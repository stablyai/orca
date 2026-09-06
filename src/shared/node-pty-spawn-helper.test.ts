import { describe, expect, it } from 'vitest'
import { usesNodePtySpawnHelper } from './node-pty-spawn-helper'

describe('usesNodePtySpawnHelper', () => {
  it('is macOS only', () => {
    // The predicate this file exists for: node-pty's binding.gyp declares the
    // spawn-helper target inside OS=="mac". Reading it as "every non-Windows platform"
    // is what reported spawn_helper_missing on healthy Linux hosts (#17844).
    expect(usesNodePtySpawnHelper('darwin')).toBe(true)
    for (const platform of ['linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix']) {
      expect(usesNodePtySpawnHelper(platform)).toBe(false)
    }
  })
})
