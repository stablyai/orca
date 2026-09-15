// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeaderPath } from './EditorPanelHeaderPath'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./editor-header-file-rename', () => ({
  useEditorHeaderFileRename: () => ({
    canRename: true,
    currentFileName: 'Onboarding Questions.md',
    isRenaming: false,
    renameInputRef: () => {},
    openRenameInput: vi.fn(),
    commitRename: vi.fn(),
    cancelRename: vi.fn()
  })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => ''
}))

const CHARACTER_WIDTH = 10

const ICLOUD_PATH =
  '/Users/example/Library/Mobile Documents/iCloud~md~obsidian/Documents/Ebrain/Projects/Onboarding Questions.md'

const activeFile: OpenFile = {
  id: `edit:${ICLOUD_PATH}`,
  filePath: ICLOUD_PATH,
  relativePath: 'Projects/Onboarding Questions.md',
  worktreeId: 'repo::/repo',
  language: 'markdown',
  isDirty: false,
  mode: 'edit'
}

const baseProps = {
  activeFile,
  copiedPathVisible: false,
  canShowMarkdownPreview: false,
  onCopyPath: vi.fn(),
  onOpenMarkdownPreview: vi.fn(),
  onOpenContainingFolder: vi.fn()
}

describe('EditorPanelHeaderPath', () => {
  let container: HTMLDivElement
  let root: Root
  let originalClientWidth: PropertyDescriptor | undefined
  let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    // Why: happy-dom reports zero-size boxes, so the measuring probe needs a
    // deterministic monospace width to force the label into truncation.
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === 'BUTTON' ? 45 * CHARACTER_WIDTH : 0
      }
    })

    originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      return { width: (this.textContent ?? '').length * CHARACTER_WIDTH, height: 16 } as DOMRect
    }
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
  })

  it('announces the full path while showing the truncated label', async () => {
    await act(async () => {
      root.render(<EditorPanelHeaderPath {...baseProps} />)
    })

    const button = container.querySelector('.editor-header-path')
    expect(button?.getAttribute('aria-label')).toBe(ICLOUD_PATH)
    expect(button?.textContent?.startsWith('…')).toBe(true)
    expect(button?.textContent).not.toBe(ICLOUD_PATH)
  })
})
