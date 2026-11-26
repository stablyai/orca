// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installAppKeyboardRouter } from '@/lib/keyboard/app-keyboard-router'
import { createFileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import type { TreeNode } from '../tree/file-explorer-types'
import { useFileExplorerClickRename } from './use-file-explorer-click-rename'

const fileRow: TreeNode = {
  name: 'notes.md',
  path: '/repo/notes.md',
  relativePath: 'notes.md',
  isDirectory: false,
  depth: 0
}

function setup() {
  installAppKeyboardRouter(window)
  const container = document.createElement('div')
  container.innerHTML = '<div data-index="0"><button>notes.md</button></div>'
  // Stands in for the editor the click opened and focused.
  const editor = document.createElement('textarea')
  document.body.append(container, editor)
  const editorKeys: string[] = []
  editor.addEventListener('keydown', (event) => editorKeys.push(event.key))
  const startRename = vi.fn()
  renderHook(() =>
    useFileExplorerClickRename({
      containerRef: { current: container },
      rowProjection: createFileExplorerRowProjection([fileRow]),
      startRename
    })
  )
  const clickRow = (): void => {
    container
      .querySelector('button')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    editor.focus()
  }
  const press = (key: string): void => {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }
  return { clickRow, press, startRename, editorKeys }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useFileExplorerClickRename', () => {
  it('renames the clicked row when F2 follows the click, keeping it from the editor', () => {
    const { clickRow, press, startRename, editorKeys } = setup()
    clickRow()
    press('F2')
    expect(startRename).toHaveBeenCalledWith(fileRow)
    expect(editorKeys).toEqual([])
  })

  it('leaves F2 to the editor once another key was typed, until the next row click', () => {
    const { clickRow, press, startRename, editorKeys } = setup()
    clickRow()
    press('a')
    press('F2')
    expect(startRename).not.toHaveBeenCalled()
    expect(editorKeys).toEqual(['a', 'F2'])
    clickRow()
    press('F2')
    expect(startRename).toHaveBeenCalledWith(fileRow)
    expect(editorKeys).toEqual(['a', 'F2'])
  })
})
