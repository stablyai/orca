// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RichMarkdownEmojiMenu } from './RichMarkdownEmojiMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('emoji-picker-react', () => ({
  default: () => <input aria-label="Search emoji" />,
  EmojiStyle: { NATIVE: 'native' },
  Theme: { DARK: 'dark', LIGHT: 'light' }
}))

let editorRoot: HTMLDivElement
let reactRoot: Root

beforeEach(() => {
  editorRoot = document.createElement('div')
  document.body.append(editorRoot)
  reactRoot = createRoot(editorRoot)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  document.body.innerHTML = ''
})

function renderMenu(onClose: () => void): void {
  act(() =>
    reactRoot.render(
      <RichMarkdownEmojiMenu
        editor={null}
        anchorElement={editorRoot}
        left={10}
        top={20}
        onClose={onClose}
      />
    )
  )
}

it('dismisses on Escape and on an outside pointer press', async () => {
  const onClose = vi.fn()
  renderMenu(onClose)
  // Radix arms its outside-pointer listener on the next task after mount.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
    'Choose an emoji'
  )

  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(onClose).toHaveBeenCalledTimes(1)

  const outside = document.createElement('button')
  document.body.append(outside)
  act(() => {
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
  expect(onClose).toHaveBeenCalledTimes(2)
})

it('dismisses when its workspace is hidden while still painted (opacity-0 + inert)', async () => {
  const workspace = document.createElement('div')
  document.body.append(workspace)
  workspace.append(editorRoot)
  const onClose = vi.fn()
  renderMenu(onClose)

  workspace.className = 'absolute inset-0 flex'
  await act(() => Promise.resolve())
  expect(onClose).not.toHaveBeenCalled()

  workspace.inert = true
  workspace.setAttribute('aria-hidden', 'true')
  await act(() => Promise.resolve())
  expect(onClose).toHaveBeenCalled()
})
