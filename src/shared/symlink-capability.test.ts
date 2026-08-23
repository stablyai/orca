import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as SymlinkCapability from './symlink-capability'
import {
  canCreateDirectorySymlink,
  canCreateFileSymlink,
  directoryLinkType
} from './symlink-capability'

const created: string[] = []

afterAll(() => {
  for (const directory of created) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-symlink-cap-'))
  created.push(directory)
  return directory
}

/** Whether the running process really can do it, decided the only honest way. */
function reallyCanLink(type: 'file' | 'junction'): boolean {
  const directory = scratch()
  const target = type === 'file' ? join(directory, 'target.txt') : directory
  if (type === 'file') {
    // A dangling link is enough to prove the privilege; no need to create the file.
  }
  try {
    symlinkSync(target, join(directory, 'link'), type)
    return true
  } catch {
    return false
  }
}

describe('symlink capability', () => {
  it('reports what this process can actually do, not what its platform usually can', () => {
    expect(canCreateFileSymlink()).toBe(reallyCanLink('file'))
  })

  it('reports directory linking separately, because a junction needs no privilege', () => {
    expect(canCreateDirectorySymlink()).toBe(reallyCanLink('junction'))
  })

  it('answers the same way every time, so a suite cannot half-skip', () => {
    expect(canCreateFileSymlink()).toBe(canCreateFileSymlink())
    expect(canCreateDirectorySymlink()).toBe(canCreateDirectorySymlink())
  })

  it('always permits both on a platform with no privilege model for links', () => {
    if (process.platform === 'win32') {
      return
    }

    expect(canCreateFileSymlink()).toBe(true)
    expect(canCreateDirectorySymlink()).toBe(true)
  })

  it('leaves no probe artifacts behind in the temp directory it used', () => {
    // Why: the probe runs once per process, but a leaked scratch dir per worker
    // across a 6000-file suite is a real mess on a developer's machine.
    canCreateFileSymlink()
    canCreateDirectorySymlink()

    expect(probeArtifactCount()).toBe(0)
  })
})

describe('directoryLinkType', () => {
  it('asks for a junction on Windows and a plain dir link elsewhere', () => {
    expect(directoryLinkType()).toBe(process.platform === 'win32' ? 'junction' : 'dir')
  })

  it('names a type fs.symlink actually creates a directory link from', () => {
    const directory = scratch()

    expect(() =>
      symlinkSync(directory, join(directory, 'linked'), directoryLinkType())
    ).not.toThrow()
  })
})

describe('symlink capability when the scratch directory will not delete', () => {
  const leaked: string[] = []

  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
    // The probe's own cleanup was mocked away, so it is this suite's job.
    for (const directory of leaked.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })

  /** A fresh copy of the module whose `rmSync` always fails, as Windows'
   *  `fixWinEPERMSync` path does on a junction pointing at its own directory. */
  async function withUndeletableScratch(): Promise<{
    module: typeof SymlinkCapability
    probes: () => number
  }> {
    vi.resetModules()
    const real = await vi.importActual<typeof NodeFs>('node:fs')
    let probes = 0
    vi.doMock('node:fs', () => {
      const mocked = {
        ...real,
        mkdtempSync: (prefix: string) => {
          probes += 1
          const directory = real.mkdtempSync(prefix)
          leaked.push(directory)
          return directory
        },
        rmSync: () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
      }
      return { ...mocked, default: mocked }
    })
    return { module: await import('./symlink-capability'), probes: () => probes }
  }

  it('still answers, because a throw here fails test-file collection outright', async () => {
    const { module } = await withUndeletableScratch()

    expect(() => module.canCreateFileSymlink()).not.toThrow()
    expect(typeof module.canCreateFileSymlink()).toBe('boolean')
  })

  it('memoises that answer instead of re-probing on every caller', async () => {
    const { module, probes } = await withUndeletableScratch()

    module.canCreateFileSymlink()
    module.canCreateFileSymlink()
    module.canCreateFileSymlink()

    expect(probes()).toBe(1)
  })
})

function probeArtifactCount(): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('orca-symlink-probe-')).length
}
