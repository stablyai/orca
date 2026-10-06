import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as retryOps from './windows-retry-file-operations'
import {
  resolveCanonicalPluginWritePath,
  writeCanonicalOpenCodePluginAtomically,
  writeOverlayOpenCodePluginAtomically
} from './opencode-plugin-atomic-write'

type WriteFileSyncFn = typeof NodeFs.writeFileSync

const { fsMock } = vi.hoisted(() => {
  let realWrite: WriteFileSyncFn | undefined
  return {
    fsMock: {
      writeFileSync: vi.fn(),
      getRealWrite: (): WriteFileSyncFn | undefined => realWrite,
      setRealWrite: (fn: WriteFileSyncFn): void => {
        realWrite = fn
      }
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  fsMock.setRealWrite(actual.writeFileSync)
  fsMock.writeFileSync.mockImplementation((...args: Parameters<WriteFileSyncFn>) =>
    actual.writeFileSync(...args)
  )
  return {
    ...actual,
    writeFileSync: fsMock.writeFileSync
  }
})

afterEach(() => {
  const realWrite = fsMock.getRealWrite()
  if (realWrite) {
    fsMock.writeFileSync.mockImplementation((...args: Parameters<WriteFileSyncFn>) =>
      realWrite(...args)
    )
  }
  vi.restoreAllMocks()
})

describe('opencode-plugin-atomic-write', () => {
  it('writes atomically via sibling temp file and never writes directly in place', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-atomic-write-'))
    const pluginPath = join(testDir, 'plugins', 'orca-opencode-status.js')
    const writtenPaths: string[] = []

    const realWrite = fsMock.getRealWrite()
    expect(realWrite).toBeDefined()
    if (!realWrite) {
      return
    }

    fsMock.writeFileSync.mockImplementation(
      (
        file: Parameters<WriteFileSyncFn>[0],
        data: Parameters<WriteFileSyncFn>[1],
        options: Parameters<WriteFileSyncFn>[2]
      ) => {
        writtenPaths.push(String(file))
        return realWrite(file, data, options)
      }
    )

    try {
      writeCanonicalOpenCodePluginAtomically(pluginPath, 'console.log("hello")')
      expect(readFileSync(pluginPath, 'utf8')).toBe('console.log("hello")')
      expect(writtenPaths).toHaveLength(1)
      expect(writtenPaths[0]).not.toBe(pluginPath)
      expect(writtenPaths[0]).toContain('.orca-opencode-status.js.')
      expect(writtenPaths[0]).toContain('.tmp')
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('preserves symlink and updates underlying target in canonical mode', () => {
    if (process.platform === 'win32') {
      return
    }
    const realWrite = fsMock.getRealWrite()
    expect(realWrite).toBeDefined()
    if (!realWrite) {
      return
    }

    const testDir = mkdtempSync(join(tmpdir(), 'opencode-canonical-symlink-'))
    const pluginsDir = join(testDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const realFile = join(testDir, 'dotfiles-plugin.js')
    const linkFile = join(pluginsDir, 'orca-opencode-status.js')

    realWrite(realFile, 'initial content', 'utf8')
    symlinkSync(realFile, linkFile)

    expect(resolveCanonicalPluginWritePath(linkFile)).toBe(realpathSync.native(realFile))

    writeCanonicalOpenCodePluginAtomically(linkFile, 'updated content')

    expect(lstatSync(linkFile).isSymbolicLink()).toBe(true)
    expect(readFileSync(realFile, 'utf8')).toBe('updated content')
    expect(readFileSync(linkFile, 'utf8')).toBe('updated content')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('preserves dangling symlink and creates destination target in canonical mode', () => {
    if (process.platform === 'win32') {
      return
    }
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-dangling-symlink-'))
    const pluginsDir = join(testDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const missingTarget = join(testDir, 'dotfiles-plugin.js')
    const linkFile = join(pluginsDir, 'orca-opencode-status.js')

    symlinkSync(missingTarget, linkFile)
    expect(existsSync(missingTarget)).toBe(false)
    expect(lstatSync(linkFile).isSymbolicLink()).toBe(true)

    expect(resolveCanonicalPluginWritePath(linkFile)).toBe(missingTarget)

    writeCanonicalOpenCodePluginAtomically(linkFile, 'dangling resolved content')

    expect(lstatSync(linkFile).isSymbolicLink()).toBe(true)
    expect(existsSync(missingTarget)).toBe(true)
    expect(readFileSync(missingTarget, 'utf8')).toBe('dangling resolved content')
    expect(readFileSync(linkFile, 'utf8')).toBe('dangling resolved content')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('preserves existing file permissions when updating plugin', () => {
    if (process.platform === 'win32') {
      return
    }
    const realWrite = fsMock.getRealWrite()
    if (!realWrite) {
      return
    }
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-permissions-'))
    const pluginPath = join(testDir, 'status.js')

    realWrite(pluginPath, 'old content', { encoding: 'utf8', mode: 0o600 })
    expect(statSync(pluginPath).mode & 0o777).toBe(0o600)

    writeCanonicalOpenCodePluginAtomically(pluginPath, 'new content')
    expect(readFileSync(pluginPath, 'utf8')).toBe('new content')
    expect(statSync(pluginPath).mode & 0o777).toBe(0o600)

    rmSync(testDir, { recursive: true, force: true })
  })

  it('leaves existing target intact and cleans up temp file if rename fails', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-rename-fail-'))
    const pluginPath = join(testDir, 'status.js')
    const realWrite = fsMock.getRealWrite()
    if (!realWrite) {
      return
    }
    realWrite(pluginPath, 'original content', 'utf8')

    vi.spyOn(retryOps, 'renameFileWithWindowsRetry').mockImplementation(() => {
      throw new Error('EPERM: file locked')
    })

    expect(() => writeCanonicalOpenCodePluginAtomically(pluginPath, 'new content')).toThrow(
      'EPERM: file locked'
    )
    expect(readFileSync(pluginPath, 'utf8')).toBe('original content')
    expect(readdirSync(testDir).filter((name) => name.endsWith('.tmp'))).toEqual([])

    rmSync(testDir, { recursive: true, force: true })
  })

  it('replaces symlink in overlay mode without mutating user target file', () => {
    if (process.platform === 'win32') {
      return
    }
    const realWrite = fsMock.getRealWrite()
    expect(realWrite).toBeDefined()
    if (!realWrite) {
      return
    }

    const testDir = mkdtempSync(join(tmpdir(), 'opencode-overlay-symlink-'))
    const pluginsDir = join(testDir, 'overlay', 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const userPlugin = join(testDir, 'user-plugin.js')
    const overlayPlugin = join(pluginsDir, 'orca-opencode-status.js')

    realWrite(userPlugin, 'user original source', 'utf8')
    symlinkSync(userPlugin, overlayPlugin)

    writeOverlayOpenCodePluginAtomically(overlayPlugin, 'orca status source')

    expect(lstatSync(overlayPlugin).isSymbolicLink()).toBe(false)
    expect(lstatSync(overlayPlugin).isFile()).toBe(true)
    expect(readFileSync(overlayPlugin, 'utf8')).toBe('orca status source')
    expect(readFileSync(userPlugin, 'utf8')).toBe('user original source')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('creates missing directories automatically when writing plugin', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-nested-dir-'))
    const deeplyNestedPlugin = join(testDir, 'nested', 'path', 'plugins', 'status.js')

    writeOverlayOpenCodePluginAtomically(deeplyNestedPlugin, 'content')
    expect(existsSync(deeplyNestedPlugin)).toBe(true)
    expect(readFileSync(deeplyNestedPlugin, 'utf8')).toBe('content')

    rmSync(testDir, { recursive: true, force: true })
  })

  it('resolves long dangling symlink chains and creates target without replacing intermediate links', () => {
    if (process.platform === 'win32') {
      return
    }
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-long-symlinks-'))
    const missingTarget = join(testDir, 'final-target.js')
    let current = missingTarget
    const links: string[] = []
    for (let i = 0; i < 15; i++) {
      const nextLink = join(testDir, `link-${i}.js`)
      symlinkSync(current, nextLink)
      current = nextLink
      links.push(nextLink)
    }

    writeCanonicalOpenCodePluginAtomically(current, 'long chain content')

    expect(existsSync(missingTarget)).toBe(true)
    expect(readFileSync(missingTarget, 'utf8')).toBe('long chain content')
    for (const link of links) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    }

    rmSync(testDir, { recursive: true, force: true })
  })

  it('throws on symlink loop without replacing intermediate symlinks', () => {
    if (process.platform === 'win32') {
      return
    }
    const testDir = mkdtempSync(join(tmpdir(), 'opencode-loop-symlinks-'))
    const linkA = join(testDir, 'link-a.js')
    const linkB = join(testDir, 'link-b.js')
    symlinkSync(linkB, linkA)
    symlinkSync(linkA, linkB)

    expect(() => writeCanonicalOpenCodePluginAtomically(linkA, 'loop content')).toThrow(
      /ELOOP|symbolic link/i
    )
    expect(lstatSync(linkA).isSymbolicLink()).toBe(true)
    expect(lstatSync(linkB).isSymbolicLink()).toBe(true)

    rmSync(testDir, { recursive: true, force: true })
  })
})
