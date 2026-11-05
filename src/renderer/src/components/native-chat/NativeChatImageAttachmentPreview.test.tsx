import { NativeChatImageCommentsContext } from './NativeChatImageCommentsProvider'
// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const mocks = vi.hoisted(() => ({
  useLocalImageSrc: vi.fn(),
  getConnectionIdForFile: vi.fn(() => {
    throw new Error('Image preview fixtures must not resolve editor file connections')
  })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

vi.mock('@/components/editor/document-images/useLocalImageSrc', () => ({
  useLocalImageSrc: mocks.useLocalImageSrc
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mocks.useLocalImageSrc.mockReset()
  expect(mocks.getConnectionIdForFile).not.toHaveBeenCalled()
  mocks.getConnectionIdForFile.mockClear()
})

function renderPreview(
  attachment: NativeChatComposerImageAttachment,
  hostEnvironmentId?: string
): void {
  vi.stubGlobal('IntersectionObserver', undefined)
  render(
    <NativeChatImageAttachmentPreview
      number={1}
      attachment={attachment}
      hostEnvironmentId={hostEnvironmentId}
      onRemove={vi.fn()}
    />
  )
}

async function clickOn(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('NativeChatImageAttachmentPreview', () => {
  it('stays open through a click on the chat context menu, but not elsewhere outside', async () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-1')
    renderPreview({ id: 'a1', path: '/tmp/example.png', previewUrl: 'data:thumbnail' })
    fireEvent.click(screen.getByRole('button', { name: 'Image #1: View image: example.png' }))
    expect(
      within(screen.getByRole('dialog'))
        .getByTestId('pan-zoom-image-canvas')
        .closest('[data-native-chat-copy-image-src]')
        ?.getAttribute('data-native-chat-copy-image-src')
    ).toBe('blob:on-disk-1')
    const menu = document.body.appendChild(document.createElement('div'))
    menu.setAttribute('data-native-chat-context-menu', '')
    const copyItem = menu.appendChild(document.createElement('div'))
    const elsewhere = document.body.appendChild(document.createElement('div'))
    // Radix arms its outside-pointer listener a tick after the dialog opens.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    await clickOn(copyItem)
    expect(screen.queryByRole('dialog')).toBeTruthy()

    await clickOn(elsewhere)
    expect(screen.queryByRole('dialog')).toBeNull()
    menu.remove()
    elsewhere.remove()
  })
})

it('offers comments only after the original attachment is available', async () => {
  const attachment = {
    id: 'image',
    path: '/tmp/original.png',
    previewUrl: 'data:image/png;base64,cG5n'
  }
  mocks.useLocalImageSrc.mockReturnValue(undefined)
  const openComments = vi.fn()
  const view = () => (
    <NativeChatImageCommentsContext.Provider value={openComments}>
      <NativeChatImageAttachmentPreview attachment={attachment} onRemove={() => {}} />
    </NativeChatImageCommentsContext.Provider>
  )
  const result = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'View image: original.png' }))
  expect(screen.queryByRole('button', { name: 'Comment on image' })).toBeNull()
  mocks.useLocalImageSrc.mockReturnValue('blob:original')
  result.rerender(view())
  expect(screen.getByRole('button', { name: 'Comment on image' })).toBeTruthy()
})
