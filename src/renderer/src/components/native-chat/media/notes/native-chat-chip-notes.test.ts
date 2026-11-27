// @vitest-environment happy-dom
// Message box chips and the marked images Annotate adds to them.
import { createElement } from 'react'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatGeneratedImageAttach } from '../../paste/use-native-chat-generated-image-attach'
import { NativeChatImageAttachmentPreview } from '../../attachments/chips/NativeChatImageAttachmentPreview'

vi.mock('@/components/editor/document-images/useLocalImageSrc', () => ({
  useLocalImageSrc: () => undefined,
  loadLocalImageSrc: vi.fn()
}))

const UNAVAILABLE = 'Notes can’t be drawn on this image.'
const annotate = (): HTMLElement => screen.getByRole('button', { name: /Annotate/ })

afterEach(() => {
  document.body.replaceChildren()
})

it('reads a drawn image’s bytes before it starts a chip, so a failed read leaves none', async () => {
  const startImageChip = vi.fn(() => ({ id: 'pending-1', reveal: () => {} }))
  const saveClipboardImage = vi.fn(async () => true)
  const { result } = renderHook(() =>
    useNativeChatGeneratedImageAttach(
      { startImageChip, saveClipboardImage, canPaste: () => true },
      () => ({ kind: 'local' }),
      vi.fn()
    )
  )
  const image = new Blob(['png'], { type: 'image/png' })
  image.arrayBuffer = () => Promise.reject(new Error('Out of memory'))
  await expect(result.current(image)).rejects.toThrow('Out of memory')
  expect(startImageChip).not.toHaveBeenCalled()
})

it('a chip in a chat’s message box can be annotated', () => {
  render(
    createElement(NativeChatImageAttachmentPreview, {
      attachment: { id: 'chip-1', path: '/tmp/shot.png', previewUrl: 'data:image/png;base64,' },
      notesScopeKey: 'agent-session:chips',
      onRemove: vi.fn()
    })
  )
  fireEvent.click(screen.getByTitle('shot.png'))
  // Annotate waits for the image to load, but nothing makes it unavailable.
  expect(annotate().getAttribute('title')).not.toBe(UNAVAILABLE)
})

it('a chip outside a chat’s message box (an item comment, the browser strip) opens view-only', () => {
  // Removable there, but with no chat draft for notes to go to.
  render(
    createElement(NativeChatImageAttachmentPreview, {
      attachment: { id: 'comment-1', path: '/tmp/shot.png', previewUrl: 'data:image/png;base64,' },
      onRemove: vi.fn()
    })
  )
  fireEvent.click(screen.getByTitle('shot.png'))
  expect(annotate().getAttribute('title')).toBe(UNAVAILABLE)
})
