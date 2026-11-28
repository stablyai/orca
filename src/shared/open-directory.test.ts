import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Windows path must never reach opendir, which is what crashes there.
function refuseOnWindows(): void {
  if (process.platform === 'win32') {
    throw new Error('opendir called on Windows')
  }
}
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    opendirSync: (...args: Parameters<typeof fs.opendirSync>) => {
      refuseOnWindows()
      return fs.opendirSync(...args)
    }
  }
})
const realFs = vi.hoisted((): { opendir?: typeof FsPromises.opendir } => ({}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  realFs.opendir = fs.opendir
  return {
    ...fs,
    opendir: (...args: Parameters<typeof fs.opendir>) => {
      refuseOnWindows()
      return fs.opendir(...args)
    }
  }
})

import { openDirectory, openDirectorySync, type DirectoryHandle } from './open-directory'

const originalPlatform = process.platform
let root = ''

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

async function listNames(directory: DirectoryHandle): Promise<string[]> {
  const names: string[] = []
  for await (const entry of directory) {
    names.push(`${entry.name}:${entry.isDirectory() ? 'dir' : 'file'}`)
  }
  return names.sort()
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'open-directory-'))
  await writeFile(path.join(root, 'Tool.CMD'), '')
  await mkdir(path.join(root, 'nested'))
})

afterEach(async () => {
  setPlatform(originalPlatform)
  await rm(root, { recursive: true, force: true })
})

describe('openDirectory on Windows', () => {
  it('lists what opendir lists and rejects missing or non-folder paths', async () => {
    const realOpendir = realFs.opendir
    if (!realOpendir) {
      throw new Error('node:fs/promises mock did not load')
    }
    const expected = await listNames(await realOpendir(root))
    setPlatform('win32')

    expect(await listNames(await openDirectory(root))).toEqual(expected)
    const sync = openDirectorySync(root)
    const syncNames: string[] = []
    for (let entry = sync.readSync(); entry; entry = sync.readSync()) {
      syncNames.push(`${entry.name}:${entry.isDirectory() ? 'dir' : 'file'}`)
    }
    expect(syncNames.sort()).toEqual(expected)

    await expect(openDirectory(path.join(root, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(openDirectory(path.join(root, 'Tool.CMD'))).rejects.toMatchObject({
      code: 'ENOTDIR'
    })
    expect(() => openDirectorySync(path.join(root, 'missing'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    )
  })
})

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SCAN_ROOTS = ['src/main', 'src/shared'].map((dir) => path.join(REPO_ROOT, dir))
// fs.cp walks folders with opendir; cpSync does only when given a filter (its default path is native).
const DIRECT_OPENDIR =
  /(?<![\w$])(opendir(Sync)?|cp)\s*\(|\{[^}]*\b(opendir(Sync)?|cp)\b[^}]*\}\s*from\s*'(node:)?fs|\.cp\(/
// The helper itself, plus script text that runs in child processes.
const ALLOWED = new Set([
  'src/shared/open-directory.ts',
  'src/shared/copy-path.ts',
  'src/main/managed-server/host-state/orcad-windows-host-state-ops.ts',
  'src/main/daemon/permissions/daemon-folder-access-probe.ts',
  'src/main/codex/history/shared-store/codex-thread-lock-probe-scripts.ts'
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(full)
    }
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : []
  })
}

describe('direct opendir use', () => {
  it('goes through openDirectory or copyPath so Windows never opens a folder with opendir', () => {
    const offenders = SCAN_ROOTS.flatMap(sourceFiles)
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => DIRECT_OPENDIR.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
    expect(offenders).toEqual([])
  })
})
