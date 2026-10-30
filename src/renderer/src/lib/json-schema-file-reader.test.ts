import { beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { toEditorModelUri } from '@/components/editor/editor-model-uri'
import { readJsonSchemaFile } from './json-schema-file-reader'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  context: vi.fn(),
  read: vi.fn(),
  owner: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('./editor-file-operation-owner', () => ({ getEditorFileOperationContext: mocks.context }))
vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFilePreview: mocks.read }))
vi.mock('@/components/editor/editor-model-owner', () => ({ getEditorModelOwnerKey: mocks.owner }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.owner.mockReturnValue('remote-a')
  mocks.getState.mockReturnValue({
    openFiles: [
      {
        id: 'config',
        worktreeId: 'remote/repo',
        filePath: '/repo/config.json',
        relativePath: 'config.json'
      }
    ]
  })
  mocks.context.mockReturnValue({
    target: { kind: 'environment', environmentId: 'remote-a' },
    worktreePath: '/repo'
  })
  mocks.read.mockResolvedValue({ isBinary: false, content: '{"type":"object"}' })
})

describe('workspace JSON schemas', () => {
  it.each([
    ['C:\\repo\\config.json', 'C:\\repo\\schema.json', 'c:/repo/schema.json'],
    ['/repo/config.json', '/repo/schema.json', '/repo/schema.json'],
    [
      '\\\\server\\share\\repo\\config.json',
      '\\\\server\\share\\repo\\schema.json',
      '//server/share/repo/schema.json'
    ]
  ])(
    'preserves the remote host path independent of renderer OS: %s',
    async (config, schema, expected) => {
      mocks.getState.mockReturnValue({
        openFiles: [
          { id: 'config', worktreeId: 'remote/repo', filePath: config, relativePath: 'config.json' }
        ]
      })
      await readJsonSchemaFile(toEditorModelUri(schema, 'remote-a'))
      expect(mocks.read).toHaveBeenCalledWith(mocks.context.mock.results[0].value, expected)
    }
  )
  it('reads through the captured workspace owner, without using active host state', async () => {
    const uri = toEditorModelUri('/repo/schema.json', 'remote-a')
    await expect(readJsonSchemaFile(uri)).resolves.toContain('object')
    expect(mocks.read).toHaveBeenCalledWith(
      mocks.context.mock.results[0].value,
      '/repo/schema.json'
    )
  })

  it('does not fall back from a remote URI to a same-path file on another host', async () => {
    await expect(
      readJsonSchemaFile(toEditorModelUri('/repo/schema.json', 'remote-b'))
    ).rejects.toThrow('owning open workspace')
    await expect(readJsonSchemaFile('file:///repo/schema.json')).rejects.toThrow(
      'relative workspace'
    )
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('rejects schema paths outside the workspace and unsupported schemes', async () => {
    const model = URI.parse(toEditorModelUri('/repo/config.json', 'remote-a'))
    await expect(
      readJsonSchemaFile(model.with({ path: '/secrets/schema.json' }).toString())
    ).rejects.toThrow('outside')
    await expect(readJsonSchemaFile('data:application/json,{}')).rejects.toThrow('Unsupported')
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('does not read after ownership validation fails', async () => {
    mocks.context.mockImplementation(() => {
      throw new Error('host changed')
    })
    await expect(
      readJsonSchemaFile(toEditorModelUri('/repo/schema.json', 'remote-a'))
    ).rejects.toThrow('host changed')
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('rejects binary schemas', async () => {
    mocks.read.mockResolvedValue({ isBinary: true, content: '' })
    await expect(
      readJsonSchemaFile(toEditorModelUri('/repo/schema.json', 'remote-a'))
    ).rejects.toThrow('not a text file')
  })
})
