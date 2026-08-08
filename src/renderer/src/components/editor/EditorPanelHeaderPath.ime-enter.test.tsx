// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const commitRename = vi.fn()
const cancelRename = vi.fn()

vi.mock('./editor-header-file-rename', () => ({
  useEditorHeaderFileRename: () => ({
    canRename: false,
    currentFileName: '메모.md',
    isRenaming: true,
    renameInputRef: () => {},
    openRenameInput: () => {},
    commitRename,
    cancelRename
  })
}))

const { EditorPanelHeaderPath } = await import('./EditorPanelHeaderPath')

const activeFile = {
  worktreeId: 'wt-1',
  filePath: '/work/repo/메모.md',
  mode: 'edit'
} as unknown as OpenFile

function dispatchKey(
  input: HTMLInputElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit
): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
}

/** macOS 2-Set Korean confirm gesture: the confirming Enter is redispatched unmarked, after keyup. */
function dispatchRecordedGesture(input: HTMLInputElement): boolean {
  fireEvent.compositionStart(input)
  dispatchKey(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
  fireEvent.compositionEnd(input, { data: '가' })
  const prevented = dispatchKey(input, 'keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false
  })
  dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
  dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })
  return prevented
}

function renderHeader(): HTMLInputElement {
  render(
    <EditorPanelHeaderPath
      activeFile={activeFile}
      copiedPathVisible={false}
      canShowMarkdownPreview={false}
      onCopyPath={() => {}}
      onOpenMarkdownPreview={() => {}}
      onOpenContainingFolder={() => {}}
    />
  )
  return screen.getByRole('textbox') as HTMLInputElement
}

beforeEach(() => {
  commitRename.mockClear()
  cancelRename.mockClear()
})
afterEach(cleanup)

describe('EditorPanelHeaderPath IME Enter ownership', () => {
  it('does not rename the file on the recorded Korean confirm gesture', () => {
    const input = renderHeader()

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(commitRename).not.toHaveBeenCalled()
  })

  it('renames exactly once on an ordinary Enter', () => {
    const input = renderHeader()

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(commitRename).toHaveBeenCalledOnce()
  })

  it('still commits on blur', () => {
    const input = renderHeader()

    fireEvent.blur(input)

    expect(commitRename).toHaveBeenCalledOnce()
  })
})
