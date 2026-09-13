import { describe, expect, it, vi } from 'vitest'
import { registerLspEditorOpener, resolveLspNavigationPath } from './monaco-lsp-navigation'
import type * as monacoTypes from 'monaco-editor'

const state = vi.hoisted(() => ({
  openFile: vi.fn(),
  openFiles: [{ id: 'remote-target', filePath: '/repo/Caller.kt', worktreeId: 'remote-workspace' }],
  setPendingEditorReveal: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

describe('LSP cross-file navigation', () => {
  it.each([
    ['/repo', '', '/repo/Caller.kt', '/repo/Caller.kt'],
    ['C:\\repo', '', '/c:/repo/Caller.kt', 'C:\\repo\\Caller.kt'],
    [
      '\\\\server\\share\\repo',
      'server',
      '/share/repo/Caller.kt',
      '\\\\server\\share\\repo\\Caller.kt'
    ],
    ['/repo', '', '/repo/a b.kt', '/repo/a b.kt']
  ])('resolves host paths for %s', (root, authority, path, expected) => {
    expect(resolveLspNavigationPath({ scheme: 'file', authority, path }, root)?.filePath).toBe(
      expected
    )
  })

  it.each([
    ['file', '', '/repo/../secret.kt'],
    ['file', '', '/repo-other/Caller.kt'],
    ['file', 'other-host', '/repo/Caller.kt'],
    ['jar', '', '/repo/library.jar'],
    ['https', '', '/repo/Caller.kt']
  ])('rejects unsupported or out-of-workspace destinations %s:%s%s', (scheme, authority, path) => {
    expect(resolveLspNavigationPath({ scheme, authority, path }, '/repo')).toBeNull()
  })

  it('opens a destination using the source workspace and reveals the selected range', async () => {
    let opener: monacoTypes.editor.ICodeEditorOpener | undefined
    const monaco = {
      editor: {
        registerEditorOpener: (value: monacoTypes.editor.ICodeEditorOpener) => {
          opener = value
          return { dispose: () => {} }
        }
      }
    }
    registerLspEditorOpener(monaco as never, () => ({
      worktreeId: 'remote-workspace',
      worktreePath: '/repo',
      filePath: '/repo/Seat.kt',
      languageId: 'kotlin',
      content: '',
      connectionId: 'ssh-owner'
    }))
    const opened = await opener?.openCodeEditor(
      { getModel: () => ({}) } as never,
      { scheme: 'file', authority: '', path: '/repo/Caller.kt' } as never,
      { startLineNumber: 9, startColumn: 4, endLineNumber: 9, endColumn: 10 }
    )
    expect(opened).toBe(true)
    expect(state.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/Caller.kt',
        worktreeId: 'remote-workspace',
        runtimeEnvironmentId: null,
        language: 'kotlin'
      }),
      { preview: true, suppressActiveRuntimeFallback: true }
    )
    expect(state.setPendingEditorReveal).toHaveBeenCalledWith({
      fileId: 'remote-target',
      filePath: '/repo/Caller.kt',
      line: 9,
      column: 4,
      matchLength: 6
    })
  })
})
