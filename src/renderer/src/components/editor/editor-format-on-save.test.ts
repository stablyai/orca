import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-file-client', () => ({ readRuntimeFileContent: vi.fn() }))

import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { formatSavedFile, maybeFormatSavedFile } from './editor-format-on-save'

beforeEach(() => {
  toastError.mockReset()
})

function request(overrides: {
  runFormat: Parameters<typeof formatSavedFile>[0]['runFormat']
  readSavedContent?: Parameters<typeof formatSavedFile>[0]['readSavedContent']
  savedContent?: string
}): Parameters<typeof formatSavedFile>[0] {
  return {
    repoId: 'repo-1',
    worktreePath: '/repo',
    filePath: '/repo/src/a.ts',
    savedContent: overrides.savedContent ?? 'const a=1',
    runFormat: overrides.runFormat,
    readSavedContent: overrides.readSavedContent ?? (async () => 'const a = 1')
  }
}

describe('formatSavedFile', () => {
  it('returns the reformatted text when the formatter rewrote the file', async () => {
    await expect(
      formatSavedFile(request({ runFormat: async () => ({ status: 'completed' }) }))
    ).resolves.toBe('const a = 1')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('returns null when the formatter left the file byte-identical', async () => {
    await expect(
      formatSavedFile(
        request({
          runFormat: async () => ({ status: 'completed' }),
          readSavedContent: async () => 'const a=1'
        })
      )
    ).resolves.toBeNull()
  })

  it('surfaces the formatter error without touching the buffer', async () => {
    await expect(
      formatSavedFile(
        request({
          runFormat: async () => ({ status: 'failed', message: 'SyntaxError: line 3' }),
          readSavedContent: async () => 'const a=1'
        })
      )
    ).resolves.toBeNull()

    expect(toastError).toHaveBeenCalledWith(
      'Formatter failed',
      expect.objectContaining({ description: 'SyntaxError: line 3' })
    )
  })

  it('truncates a runaway formatter error so the toast stays readable', async () => {
    await expect(
      formatSavedFile(
        request({
          runFormat: async () => ({ status: 'failed', message: 'x'.repeat(1000) }),
          readSavedContent: async () => 'const a=1'
        })
      )
    ).resolves.toBeNull()

    const description = toastError.mock.calls[0][1].description as string
    expect(description).toHaveLength(301)
    expect(description.endsWith('…')).toBe(true)
  })

  it('stays silent for every skip reason', async () => {
    for (const reason of [
      'not-configured',
      'not-included',
      'outside-worktree',
      'already-running',
      'unsupported-host'
    ] as const) {
      await expect(
        formatSavedFile(request({ runFormat: async () => ({ status: 'skipped', reason }) }))
      ).resolves.toBeNull()
    }
    expect(toastError).not.toHaveBeenCalled()
  })

  it('keeps the save successful when the format channel itself throws', async () => {
    await expect(
      formatSavedFile(
        request({
          runFormat: async () => {
            throw new Error('ipc down')
          },
          readSavedContent: async () => 'const a=1'
        })
      )
    ).resolves.toBeNull()
  })

  it('rereads the file when a failing formatter wrote before it exited', async () => {
    await expect(
      formatSavedFile(
        request({ runFormat: async () => ({ status: 'failed', message: 'lint step failed' }) })
      )
    ).resolves.toBe('const a = 1')
    expect(toastError).toHaveBeenCalled()
  })

  it('rereads the file when the format channel throws after the formatter may have run', async () => {
    await expect(
      formatSavedFile(
        request({
          runFormat: async () => {
            throw new Error('ipc down')
          }
        })
      )
    ).resolves.toBe('const a = 1')
  })

  it('does not reread when the formatter never ran', async () => {
    const readSavedContent = vi.fn(async () => 'changed')
    await formatSavedFile(
      request({
        runFormat: async () => ({ status: 'skipped', reason: 'not-included' }),
        readSavedContent
      })
    )
    expect(readSavedContent).not.toHaveBeenCalled()
  })

  it('keeps the save successful when re-reading the formatted file fails', async () => {
    await expect(
      formatSavedFile(
        request({
          runFormat: async () => ({ status: 'completed' }),
          readSavedContent: async () => {
            throw new Error('read failed')
          }
        })
      )
    ).resolves.toBeNull()
  })
})

describe('maybeFormatSavedFile', () => {
  it('reads the formatted file through the SSH connection that ran the formatter', async () => {
    vi.mocked(readRuntimeFileContent).mockResolvedValue({ content: 'formatted' } as never)
    vi.stubGlobal('window', {
      api: { editor: { formatOnSave: vi.fn().mockResolvedValue({ status: 'completed' }) } }
    })

    await expect(
      maybeFormatSavedFile({
        file: {
          filePath: '/srv/repo/a.ts',
          relativePath: 'a.ts',
          worktreeId: 'wt-1'
        } as never,
        worktree: { path: '/srv/repo', repoId: 'repo-1' } as never,
        fileContext: {
          settings: null,
          worktreeId: 'wt-1',
          worktreePath: '/srv/repo',
          connectionId: 'ssh-1',
          expectedExecutionHostId: 'ssh:ssh-1'
        },
        savedContent: 'raw'
      })
    ).resolves.toBe('formatted')

    expect(readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', filePath: '/srv/repo/a.ts' })
    )
    vi.unstubAllGlobals()
  })
})
