// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownTemplatePicker } from './MarkdownTemplatePicker'
import type { MarkdownDocumentTemplate } from '@/lib/markdown-document-templates'
import { requestMarkdownTemplateSelection } from '@/lib/markdown-template-picker-request'
import type { MarkdownTemplateSelection } from '@/lib/markdown-template-picker-request'

// Highest-severity cmdk surface: selecting here writes a new file. The picker has
// no Enter handling of its own — cmdk's root handler is its ONLY Enter path — so
// the macOS redispatch of a composition-confirming Enter created a document the
// user never asked for, mid-word.

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

const template: MarkdownDocumentTemplate = {
  id: 'design-doc',
  name: '설계 문서',
  filePath: '/repo/.orca/templates/design.md',
  relativePath: 'design.md',
  templateRelativePath: '.orca/templates/design.md',
  basename: 'design.md'
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function openPicker(): { selection: MarkdownTemplateSelection | null; input: HTMLInputElement } {
  const captured: { selection: MarkdownTemplateSelection | null } = { selection: null }
  act(() => root.render(<MarkdownTemplatePicker />))
  act(() => {
    void requestMarkdownTemplateSelection([template]).then((s) => {
      captured.selection = s
    })
  })
  const input = document.body.querySelector<HTMLInputElement>('[data-slot="command-input"]')
  if (!input) {
    throw new Error('picker did not open')
  }
  return {
    get selection() {
      return captured.selection
    },
    input
  }
}

function key(input: HTMLInputElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  Object.defineProperty(event, 'isComposing', { value: init.isComposing === true })
  act(() => input.dispatchEvent(event))
}

function composition(
  input: HTMLInputElement,
  type: 'compositionstart' | 'compositionend',
  data = ''
) {
  act(() => input.dispatchEvent(new CompositionEvent(type, { bubbles: true, data })))
}

it('does not resolve a template on the Enter that only confirms a Korean syllable', async () => {
  const picker = openPicker()

  composition(picker.input, 'compositionstart')
  key(picker.input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
  composition(picker.input, 'compositionend', '설')
  key(picker.input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
  key(picker.input, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 })
  await act(async () => {})

  expect(picker.selection).toBeNull()
})

it('resolves on an ordinary Enter', async () => {
  const picker = openPicker()

  key(picker.input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })
  await act(async () => {})

  expect(picker.selection).toEqual({ type: 'blank' })
})

it('resolves on the deliberate Enter that follows a confirmed composition', async () => {
  const picker = openPicker()

  composition(picker.input, 'compositionstart')
  key(picker.input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
  composition(picker.input, 'compositionend', '설')
  key(picker.input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
  await act(async () => {})
  expect(picker.selection).toBeNull()

  // The carry expires on the NEXT FRAME, never synchronously — macOS delivers keyup
  // before its unmarked redispatch.
  let frame: FrameRequestCallback | undefined
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frame = cb
    return 1
  })
  key(picker.input, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 })
  act(() => frame?.(0))
  raf.mockRestore()

  key(picker.input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
  await act(async () => {})

  expect(picker.selection).toEqual({ type: 'blank' })
})
