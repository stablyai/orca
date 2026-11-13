// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NativeChatImageAttachments } from './NativeChatImageAttachments'
import { resetLocalImageCacheState } from '../../../editor/document-images/local-image-src-cache'
import { readLocalImagePreview } from '../../../editor/document-images/local-image-src-reader'

vi.mock('../../../editor/document-images/local-image-src-reader', () => ({
  readLocalImagePreview: vi.fn()
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const IMAGES = ['one', 'two', 'three'].map((name) => ({
  type: 'image-ref' as const,
  url: `https://example.test/${name}.png`,
  alt: name
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  resetLocalImageCacheState()
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]')
}

function shownImage(): string | null | undefined {
  return dialog()?.querySelector('img')?.getAttribute('src')
}

async function press(key: string): Promise<void> {
  await act(async () => {
    dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeInstanceOf(HTMLElement)
  await act(async () => {
    if (element instanceof HTMLElement) {
      element.click()
    }
  })
}

describe('NativeChatImageAttachments gallery', () => {
  it('steps through a row of images in one viewer, wrapping at both ends', async () => {
    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, { blocks: IMAGES, runtimeContext: null })
      )
    })
    const thumbnails = container.querySelectorAll('button')
    expect(thumbnails).toHaveLength(3)

    await click(thumbnails[1])
    expect(shownImage()).toBe('https://example.test/two.png')
    expect(dialog()?.textContent).toContain('2 of 3')

    await press('ArrowRight')
    expect(shownImage()).toBe('https://example.test/three.png')
    expect(dialog()?.textContent).toContain('3 of 3')

    await click(dialog()?.querySelector('[aria-label="Next image"]'))
    expect(shownImage()).toBe('https://example.test/one.png')

    await press('ArrowLeft')
    expect(shownImage()).toBe('https://example.test/three.png')

    await click(dialog()?.querySelector('[aria-label="Previous image"]'))
    expect(shownImage()).toBe('https://example.test/two.png')
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('never shows the previous image while the selected local image is still loading', async () => {
    const runtimeContext = {
      target: { kind: 'local' as const },
      worktreeId: 'wt',
      worktreePath: '/repo'
    }
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:first')
    vi.mocked(readLocalImagePreview).mockImplementation((absolutePath) =>
      absolutePath.endsWith('first.png')
        ? Promise.resolve({ content: 'AAAA', isBinary: true, mimeType: 'image/png' })
        : new Promise(() => {})
    )
    const blocks = ['first', 'second'].map((name) => ({
      type: 'image-ref' as const,
      path: `/repo/${name}.png`,
      alt: name
    }))
    await act(async () => {
      root.render(createElement(NativeChatImageAttachments, { blocks, runtimeContext }))
    })

    await click(container.querySelector('button'))
    expect(shownImage()).toBe('blob:first')

    await press('ArrowRight')
    expect(dialog()?.textContent).toContain('2 of 2')
    expect(shownImage()).toBeUndefined()
  })
})
