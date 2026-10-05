import { beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import type * as Monaco from 'monaco-editor'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { registerLspEditorOpener } from './lsp-editor-opener'
import { LSP_PEEK_SCHEME } from './lsp-location-models'

vi.mock('@/components/terminal-pane/terminal-file-open-routing', () => ({
  openDetectedFilePath: vi.fn()
}))

const owner = { worktreeId: 'wt', worktreePath: '/repo', repoId: 'r' }

type Opener = Monaco.editor.ICodeEditorOpener

function setup(findOwner: (fsPath: string) => typeof owner | null = () => owner): Opener {
  let captured: Opener | null = null
  const fake = {
    Uri: URI,
    editor: {
      registerEditorOpener: (opener: Opener) => {
        captured = opener
        return { dispose: vi.fn() }
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the opener only touches Uri and editor.registerEditorOpener.
  registerLspEditorOpener(fake as unknown as typeof Monaco, findOwner)
  if (!captured) {
    throw new Error('opener not registered')
  }
  return captured
}

function sourceEditor(uri: URI) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the opener only calls getModel().uri.
  return { getModel: () => ({ uri }) } as unknown as Monaco.editor.ICodeEditor
}

const startRange = { startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 9 }

describe('registerLspEditorOpener', () => {
  beforeEach(() => vi.mocked(openDetectedFilePath).mockClear())

  it('lets Monaco handle a jump inside the same model', () => {
    const uri = URI.file('/repo/a.rb')
    expect(setup().openCodeEditor(sourceEditor(uri), uri, startRange)).toBe(false)
    expect(openDetectedFilePath).not.toHaveBeenCalled()
  })

  it('ignores other schemes', () => {
    const uri = URI.parse('diff:/repo/a.rb')
    expect(setup().openCodeEditor(sourceEditor(URI.file('/repo/b.rb')), uri, startRange)).toBe(
      false
    )
  })

  it('ignores files outside every worktree', () => {
    const uri = URI.file('/elsewhere/a.rb')
    const opener = setup(() => null)
    expect(opener.openCodeEditor(sourceEditor(URI.file('/repo/b.rb')), uri, startRange)).toBe(false)
    expect(openDetectedFilePath).not.toHaveBeenCalled()
  })

  it('maps a peek resource to its real path and opens it at the range start', () => {
    const uri = URI.from({ scheme: LSP_PEEK_SCHEME, path: '/repo/a.rb' })
    const opener = setup()
    expect(opener.openCodeEditor(sourceEditor(URI.file('/repo/b.rb')), uri, startRange)).toBe(true)
    expect(openDetectedFilePath).toHaveBeenCalledWith(URI.file('/repo/a.rb').fsPath, 4, 7, {
      worktreeId: 'wt',
      worktreePath: '/repo'
    })
  })

  it('accepts a position argument', () => {
    const uri = URI.file('/repo/a.rb')
    const opener = setup()
    const position = { lineNumber: 2, column: 3 }
    expect(opener.openCodeEditor(sourceEditor(URI.file('/repo/b.rb')), uri, position)).toBe(true)
    expect(openDetectedFilePath).toHaveBeenCalledWith(uri.fsPath, 2, 3, expect.anything())
  })
})
