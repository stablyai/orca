import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { findPosixShell, hasPosixShellAtCanonicalPath } from './posix-shell'

describe('findPosixShell', () => {
  it('returns a shell that can actually run a command', () => {
    const shell = findPosixShell()
    if (!shell) {
      return
    }

    expect(spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status).toBe(0)
  })

  it('answers the same way every time, so a suite cannot half-skip', () => {
    expect(findPosixShell()).toBe(findPosixShell())
  })

  it('finds one on every platform that ships /bin/sh', () => {
    if (process.platform === 'win32') {
      return
    }

    expect(findPosixShell()).toBe('/bin/sh')
  })
})

describe('hasPosixShellAtCanonicalPath', () => {
  it('asks specifically about /bin/sh, not about any shell on PATH', () => {
    // Why the distinction: a test that fakes `process.platform = 'linux'` drives
    // production down paths that spawn `/bin/sh` by that exact name. Git's `sh`
    // on PATH proves nothing about whether that spawn will resolve.
    expect(hasPosixShellAtCanonicalPath()).toBe(
      spawnSync('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
    )
  })

  it('is true wherever the platform ships one', () => {
    if (process.platform === 'win32') {
      return
    }

    expect(hasPosixShellAtCanonicalPath()).toBe(true)
  })
})
