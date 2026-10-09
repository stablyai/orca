import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { copyFileToOsClipboard } from './file-explorer-row-file-transfer'
import { shouldShowCopyFileAction } from './file-explorer-row-action-visibility'
import type { TreeNode } from './file-explorer-types'

const { writeClipboardFile, toastError } = vi.hoisted(() => ({
  writeClipboardFile: vi.fn().mockResolvedValue({ ok: true }),
  toastError: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-file-client', () => ({ downloadRuntimeFile: vi.fn() }))

const file: TreeNode = {
  name: 'file.txt',
  path: '/same/project/file.txt',
  relativePath: 'file.txt',
  isDirectory: false,
  depth: 0
}
const managed: TreeNode = {
  ...file,
  operationOwner: { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' }
}
const nested: TreeNode = {
  ...file,
  operationOwner: { kind: 'runtime', environmentId: 'hub', executionHostId: 'ssh:target' }
}
const unresolved: TreeNode = { ...file, operationOwner: { kind: 'unresolved' } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { ui: { writeClipboardFile } } })
})
afterEach(() => vi.unstubAllGlobals())

for (const [name, node] of [
  ['managed file', managed],
  ['managed folder', { ...managed, isDirectory: true }],
  ['nested SSH file', nested],
  ['unresolved file', unresolved]
] as const) {
  it(`does not offer desktop file Copy for a ${name}`, () => {
    expect(shouldShowCopyFileAction(node, null)).toBe(false)
  })
  it(`rejects direct clipboard calls for a ${name}`, async () => {
    await copyFileToOsClipboard(node, null)
    expect(writeClipboardFile).not.toHaveBeenCalled()
  })
}

it('retains native file and folder Copy', async () => {
  const local = { ...file, operationOwner: { kind: 'local' as const } }
  expect(shouldShowCopyFileAction(local)).toBe(true)
  expect(shouldShowCopyFileAction({ ...local, isDirectory: true })).toBe(true)
  await copyFileToOsClipboard(local)
  expect(writeClipboardFile).toHaveBeenCalledWith(file.path)
})

it('retains direct SSH file materialization and excludes directories', async () => {
  const direct = { ...file, operationOwner: { kind: 'ssh' as const, connectionId: 'target' } }
  expect(shouldShowCopyFileAction(direct, 'target')).toBe(true)
  expect(shouldShowCopyFileAction({ ...direct, isDirectory: true }, 'target')).toBe(false)
  await copyFileToOsClipboard(direct, 'target')
  expect(writeClipboardFile).toHaveBeenCalledWith({ filePath: file.path, connectionId: 'target' })
})

it('retains the single-file and desktop-client limits', () => {
  expect(shouldShowCopyFileAction(file, null, 2)).toBe(false)
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  expect(shouldShowCopyFileAction(file)).toBe(false)
})
