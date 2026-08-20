import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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

function probeArtifactCount(): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('orca-symlink-probe-')).length
}
