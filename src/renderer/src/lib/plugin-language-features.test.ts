// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { createLocationMapper } from './plugin-language-features'

vi.mock('monaco-editor', async () => ({
  ...(await import('monaco-editor/esm/vs/editor/editor.api.js')),
  typescript: { typescriptDefaults: {}, javascriptDefaults: {} }
}))
const { tab } = vi.hoisted(() => ({
  tab: { mode: 'edit', filePath: '/repo/src/a.ts', relativePath: 'src/a.ts', worktreeId: 'w1' }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ openFiles: [tab] }) } }))
vi.mock('@/store/plugin-panels', () => ({}))
vi.mock('@/store/slices/editor/file-ids/editor-file-ids', () => ({}))
vi.mock('@/store/slices/editor/focus/editor-focus-reveal', () => ({}))
vi.mock('@/runtime/runtime-file-read-client', () => ({ readRuntimeFileContent: vi.fn() }))
vi.mock('./file-owner-runtime-target', () => ({
  getRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('./connection-context', () => ({ getConnectionIdForFile: () => null }))

const read = vi.mocked(readRuntimeFileContent)
const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }
const target = { filePath: '/repo/lib/b.ts', range }

describe('createLocationMapper', () => {
  const source = monaco.editor.createModel('', 'typescript', monaco.Uri.file('/repo/src/a.ts'))
  afterEach(() => {
    read.mockReset()
    monaco.editor.getModels().forEach((model) => model !== source && model.dispose())
  })

  it('refreshes a cached preview so a new range never lands on stale text', async () => {
    const toLocations = createLocationMapper(monaco)
    read.mockResolvedValueOnce({ content: 'v1', isBinary: false })
    const [first] = await toLocations(source, [target])
    expect(monaco.editor.getModel(first.uri)?.getValue()).toBe('v1')

    read.mockResolvedValueOnce({ content: 'v2', isBinary: false })
    const [second] = await toLocations(source, [target])
    expect(second.uri.toString()).toBe(first.uri.toString())
    expect(monaco.editor.getModel(second.uri)?.getValue()).toBe('v2')

    read.mockRejectedValueOnce(new Error('gone'))
    const [third] = await toLocations(source, [target])
    expect(monaco.editor.getModel(third.uri)).toBeNull()
  })

  it('prefers the open editor model and reads each target once per request', async () => {
    const toLocations = createLocationMapper(monaco)
    read.mockResolvedValue({ content: 'disk', isBinary: false })
    const locations = await toLocations(source, [target, { ...target, range }, target])
    expect(locations).toHaveLength(3)
    expect(read).toHaveBeenCalledTimes(1)

    monaco.editor.createModel(
      'unsaved',
      'typescript',
      monaco.Uri.file('/repo/lib/b.ts').with({ fragment: 'w1' })
    )
    const [live] = await toLocations(source, [target])
    expect(monaco.editor.getModel(live.uri)?.getValue()).toBe('unsaved')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('drops targets outside the source workspace', async () => {
    const toLocations = createLocationMapper(monaco)
    expect(await toLocations(source, [{ filePath: '/home/me/.ssh/id_rsa', range }])).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })
})
