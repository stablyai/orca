// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeaderPath } from './EditorPanelHeaderPath'

const { commitRename, cancelRename } = vi.hoisted(() => ({
  commitRename: vi.fn(),
  cancelRename: vi.fn()
}))

// Why: the rename field only mounts while the hook reports isRenaming, so the
// hook is stubbed into that state instead of driving the whole rename flow.
vi.mock('./editor-header-file-rename', () => ({
  useEditorHeaderFileRename: () => ({
    canRename: true,
    currentFileName: '議事録.md',
    isRenaming: true,
    renameInputRef: { current: null },
    openRenameInput: vi.fn(),
    commitRename,
    cancelRename
  })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘⇧M'
}))

const activeFile: OpenFile = {
  id: 'edit:/repo/議事録.md',
  filePath: '/repo/議事録.md',
  relativePath: '議事録.md',
  worktreeId: 'repo::/repo',
  language: 'markdown',
  isDirty: false,
  mode: 'edit'
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  commitRename.mockClear()
  cancelRename.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

function renderHeaderPath(): HTMLInputElement {
  act(() => {
    root.render(
      <EditorPanelHeaderPath
        activeFile={activeFile}
        copiedPathVisible={false}
        canShowMarkdownPreview={false}
        onCopyPath={vi.fn()}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={vi.fn()}
      />
    )
  })
  const input = document.body.querySelector<HTMLInputElement>(
    '[data-editor-header-rename-input="true"]'
  )
  if (!input) {
    throw new Error('rename input not rendered')
  }
  return input
}

function pressEnter(
  input: HTMLInputElement,
  init?: KeyboardEventInit & { keyCode?: number }
): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    input.dispatchEvent(event)
  })
}

describe('EditorPanelHeaderPath IME Enter guard', () => {
  it('does not commit the rename on an IME-composition Enter', () => {
    const input = renderHeaderPath()

    pressEnter(input, { isComposing: true })

    expect(commitRename).not.toHaveBeenCalled()
  })

  it('does not commit it for IMEs that report keyCode 229 without isComposing', () => {
    const input = renderHeaderPath()

    pressEnter(input, { keyCode: 229 })

    expect(commitRename).not.toHaveBeenCalled()
  })

  it('still commits the rename on a plain Enter', () => {
    const input = renderHeaderPath()

    pressEnter(input)

    expect(commitRename).toHaveBeenCalledTimes(1)
  })
})
