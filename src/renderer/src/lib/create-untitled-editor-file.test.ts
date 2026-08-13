import { beforeEach, describe, expect, it, vi } from 'vitest'

const createRuntimePathMock = vi.hoisted(() => vi.fn())
const runtimePathExistsMock = vi.hoisted(() => vi.fn())
const writeRuntimeFileMock = vi.hoisted(() => vi.fn())
const deleteRuntimePathMock = vi.hoisted(() => vi.fn())

vi.mock('../runtime/runtime-file-client', () => ({
  createRuntimePath: createRuntimePathMock,
  runtimePathExists: runtimePathExistsMock,
  writeRuntimeFile: writeRuntimeFileMock,
  deleteRuntimePath: deleteRuntimePathMock
}))

import { createUntitledEditorFile } from './create-untitled-editor-file'

beforeEach(() => {
  createRuntimePathMock.mockReset().mockResolvedValue(undefined)
  runtimePathExistsMock.mockReset().mockResolvedValue(false)
  writeRuntimeFileMock.mockReset().mockResolvedValue(undefined)
  deleteRuntimePathMock.mockReset().mockResolvedValue(undefined)
})

describe('createUntitledEditorFile', () => {
  it('creates an extensionless placeholder as plaintext', async () => {
    const info = await createUntitledEditorFile('/repo', 'wt-1', undefined, null, { ext: '' })

    expect(info.relativePath).toBe('untitled')
    expect(info.filePath).toBe('/repo/untitled')
    expect(info.language).toBe('plaintext')
    expect(info.isUntitled).toBe(true)
    expect(info.mode).toBe('edit')
  })

  it('honors an explicit extension', async () => {
    const info = await createUntitledEditorFile('/repo', 'wt-1', undefined, null, { ext: '.md' })

    expect(info.relativePath).toBe('untitled.md')
    expect(info.language).toBe('markdown')
  })

  it('advances past names that already exist', async () => {
    runtimePathExistsMock.mockImplementation(async (_ctx: unknown, filePath: string) =>
      filePath.endsWith('/untitled')
    )

    const info = await createUntitledEditorFile('/repo', 'wt-1', undefined, null, { ext: '' })

    expect(info.relativePath).toBe('untitled-2')
  })

  it('retries when another writer wins the create race', async () => {
    createRuntimePathMock.mockRejectedValueOnce(new Error('EEXIST: file already exists'))

    const info = await createUntitledEditorFile('/repo', 'wt-1', undefined, null, { ext: '' })

    expect(info.relativePath).toBe('untitled-2')
  })

  it('rejects a dotless extension before touching the host', async () => {
    await expect(
      createUntitledEditorFile('/repo', 'wt-1', undefined, null, { ext: 'md' })
    ).rejects.toThrow('Untitled file extension must start with a dot, received "md".')

    expect(runtimePathExistsMock).not.toHaveBeenCalled()
    expect(createRuntimePathMock).not.toHaveBeenCalled()
  })

  it('removes the created file when the initial write fails', async () => {
    // Why: the placeholder is already on disk by then, so a failed write must not leave it behind.
    writeRuntimeFileMock.mockRejectedValueOnce(new Error('EACCES: permission denied'))

    await expect(
      createUntitledEditorFile('/repo', 'wt-1', undefined, null, {
        ext: '',
        initialContent: () => 'body'
      })
    ).rejects.toThrow('EACCES')

    expect(deleteRuntimePathMock).toHaveBeenCalledWith(expect.anything(), '/repo/untitled')
  })

  it('reports exhaustion using the caller-supplied label', async () => {
    runtimePathExistsMock.mockResolvedValue(true)

    await expect(
      createUntitledEditorFile('/repo', 'wt-1', undefined, null, {
        ext: '.md',
        exhaustionErrorLabel: 'markdown file'
      })
    ).rejects.toThrow('Unable to create untitled markdown file after 100 attempts.')
  })

  it('propagates non-EEXIST failures', async () => {
    createRuntimePathMock.mockRejectedValue(new Error('EACCES: permission denied'))

    await expect(
      createUntitledEditorFile('/repo', 'wt-1', undefined, null, { ext: '' })
    ).rejects.toThrow('EACCES')
  })
})
