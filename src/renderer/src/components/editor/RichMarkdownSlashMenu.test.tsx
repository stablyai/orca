// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RichMarkdownSlashMenu } from './RichMarkdownSlashMenu'
import { slashCommands } from './rich-markdown-slash-commands'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const ROW_HEIGHT = 30
const VIEWPORT_HEIGHT = 90

let editor: Editor
let editorElement: HTMLDivElement
let host: HTMLDivElement
let reactRoot: Root

beforeEach(() => {
  editorElement = document.createElement('div')
  document.body.append(editorElement)
  editor = new Editor({ element: editorElement, extensions: [StarterKit], content: '<p>/</p>' })
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  editor.destroy()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function renderMenu(selectedIndex: number, onClose: () => void): void {
  act(() =>
    reactRoot.render(
      <RichMarkdownSlashMenu
        editor={editor}
        slashMenu={{ query: '', from: 1, to: 2, left: 0, top: 0 }}
        filteredCommands={slashCommands}
        selectedIndex={selectedIndex}
        onImagePick={vi.fn()}
        onEmojiPick={vi.fn()}
        onClose={onClose}
      />
    )
  )
}

function layOutResults(): HTMLElement {
  const viewport = document.querySelector<HTMLElement>('.rich-markdown-slash-results')
  if (!viewport) {
    throw new Error('Missing slash results')
  }
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT })
  viewport.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, index) => {
    Object.defineProperty(option, 'offsetTop', { configurable: true, value: index * ROW_HEIGHT })
    Object.defineProperty(option, 'offsetHeight', { configurable: true, value: ROW_HEIGHT })
  })
  return viewport
}

it('scrolls keyboard selection into view in both directions', () => {
  const onClose = vi.fn()
  renderMenu(0, onClose)
  const viewport = layOutResults()

  renderMenu(10, onClose)
  expect(viewport.scrollTop).toBe(11 * ROW_HEIGHT - VIEWPORT_HEIGHT)

  renderMenu(2, onClose)
  expect(viewport.scrollTop).toBe(2 * ROW_HEIGHT)
})

it('stays open for editor clicks and closes for presses outside the editor', async () => {
  const onClose = vi.fn()
  renderMenu(0, onClose)
  // Radix arms its outside-pointer listener on the next task after mount.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  const press = (target: Element): void => {
    act(() => {
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    })
  }

  press(editor.view.dom)
  expect(onClose).not.toHaveBeenCalled()

  const outside = document.createElement('button')
  document.body.append(outside)
  press(outside)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('closes when its workspace is hidden while still painted (opacity-0 + inert)', async () => {
  const workspace = document.createElement('div')
  document.body.append(workspace)
  workspace.append(editorElement)
  const onClose = vi.fn()
  renderMenu(0, onClose)

  workspace.className = 'absolute inset-0 flex'
  await act(() => Promise.resolve())
  expect(onClose).not.toHaveBeenCalled()

  workspace.inert = true
  workspace.setAttribute('aria-hidden', 'true')
  await act(() => Promise.resolve())
  expect(onClose).toHaveBeenCalled()
})
