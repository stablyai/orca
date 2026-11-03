import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNamedFile,
  hasPathSeparator,
  isSshOwnedFileContext,
  NamedFileExistsError,
  nextUntitledName,
  suggestUntitledName
} from './create-named-file'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const context = {
  target: LOCAL,
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  connectionId: undefined
}

function stubFs(existing: string[], createFile = vi.fn().mockResolvedValue(undefined)) {
  const pathExists = vi.fn(async ({ filePath }: { filePath: string }) =>
    existing.includes(filePath)
  )
  vi.stubGlobal('window', { api: { fs: { createFile, pathExists } } })
  return { createFile, pathExists }
}

describe('nextUntitledName', () => {
  it('returns the smallest free number starting at 1', async () => {
    const taken = new Set(['Untitled1', 'Untitled2', 'Untitled4'])
    await expect(nextUntitledName(async (name) => taken.has(name))).resolves.toBe('Untitled3')
  })
})

describe('hasPathSeparator', () => {
  it('flags both slash kinds', () => {
    expect(hasPathSeparator('a/b')).toBe(true)
    expect(hasPathSeparator('a\\b')).toBe(true)
    expect(hasPathSeparator('.env')).toBe(false)
  })
})

describe('createNamedFile', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps an extensionless name and detects language from the name', async () => {
    const { createFile } = stubFs([])
    const info = await createNamedFile(context, '/repo/src', 'app.py', () => undefined)
    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/src/app.py' })
    )
    expect(info).toMatchObject({
      filePath: '/repo/src/app.py',
      relativePath: 'src/app.py',
      language: 'python',
      mode: 'edit'
    })
    expect(info).not.toHaveProperty('isUntitled')
  })

  it('uses Untitled<N> without an extension when the name is blank', async () => {
    stubFs(['/repo/Untitled1'])
    const info = await createNamedFile(context, '/repo', '  ', () => undefined)
    expect(info.relativePath).toBe('Untitled2')
  })

  it('rejects an existing name without writing', async () => {
    const { createFile } = stubFs(['/repo/Makefile'])
    await expect(
      createNamedFile(context, '/repo', 'Makefile', () => undefined)
    ).rejects.toBeInstanceOf(NamedFileExistsError)
    expect(createFile).not.toHaveBeenCalled()
  })

  it('maps an EEXIST race to the same error', async () => {
    stubFs([], vi.fn().mockRejectedValue(new Error('EEXIST: file already exists')))
    await expect(
      createNamedFile(context, '/repo', 'a.txt', () => undefined)
    ).rejects.toBeInstanceOf(NamedFileExistsError)
  })

  it('stops before touching the filesystem when the owner changed', async () => {
    const { createFile } = stubFs([])
    await expect(
      createNamedFile(context, '/repo', 'a.txt', () => {
        throw new Error('owner changed')
      })
    ).rejects.toThrow('owner changed')
    expect(createFile).not.toHaveBeenCalled()
  })
})

describe('suggestUntitledName', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('matches the name createNamedFile would pick for a blank field', async () => {
    stubFs(['/repo/Untitled1'])
    await expect(suggestUntitledName(context, '/repo', () => undefined)).resolves.toBe('Untitled2')
  })
})

describe('isSshOwnedFileContext', () => {
  it('flags a direct SSH connection and an ssh execution host, not local ones', () => {
    expect(isSshOwnedFileContext({ connectionId: 'conn-1' })).toBe(true)
    expect(isSshOwnedFileContext({ expectedExecutionHostId: 'ssh:target-1' })).toBe(true)
    expect(isSshOwnedFileContext({ expectedExecutionHostId: 'local' })).toBe(false)
    expect(isSshOwnedFileContext({})).toBe(false)
  })
})

describe('createNamedFile owner recheck', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rechecks the owner after the write and rejects instead of returning open metadata', async () => {
    const { createFile } = stubFs([])
    let calls = 0
    await expect(
      createNamedFile(context, '/repo', 'a.txt', () => {
        calls += 1
        if (calls === 3) {
          throw new Error('owner changed')
        }
      })
    ).rejects.toThrow('owner changed')
    expect(createFile).toHaveBeenCalledTimes(1)
  })
})
