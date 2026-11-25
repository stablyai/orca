// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatNotesOriginal } from './native-chat-chip-notes'
import { useNativeChatGeneratedImageAttach } from '../../paste/use-native-chat-generated-image-attach'
import { NativeChatImageAttachmentPreview } from '../../attachments/chips/NativeChatImageAttachmentPreview'
import { setNativeChatAttachmentNotes } from './native-chat-attachment-notes'

const load = vi.hoisted(() => ({ loadLocalImageSrc: vi.fn() }))
vi.mock('@/components/editor/document-images/useLocalImageSrc', () => ({
  useLocalImageSrc: () => undefined,
  loadLocalImageSrc: load.loadLocalImageSrc
}))

const NOTES = {
  mediaName: 'dashboard.png',
  source: { path: '/tmp/dashboard.png' },
  kind: 'image' as const,
  offset: 0,
  notes: []
}

it('a reopened marked chip waits for its original, then reports when it can’t be read (F1)', async () => {
  let settle: (url: string | null) => void = () => {}
  load.loadLocalImageSrc.mockReturnValue(
    new Promise<string | null>((resolve) => {
      settle = resolve
    })
  )
  const { result } = renderHook(() => useNativeChatNotesOriginal(NOTES, true, undefined))
  // Neither ready nor failed: the viewer must not open on the marked copy yet.
  expect(result.current).toEqual({ src: undefined, failed: false })
  await act(async () => settle(null))
  expect(result.current.failed).toBe(true)
})

it('a reopened marked chip whose notes are on a URL, with no file to read, opens view-only', () => {
  const { result } = renderHook(() =>
    useNativeChatNotesOriginal(
      { ...NOTES, source: { url: 'https://example.test/a.png' } },
      true,
      undefined
    )
  )
  expect(result.current).toEqual({ src: undefined, failed: true })
})

it('reads a drawn image’s bytes before it starts a chip, so a failed read leaves none (F19)', async () => {
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

it('a marked chip opens its viewer only once the clean original is read or known missing (F1)', async () => {
  let settle: (url: string | null) => void = () => {}
  load.loadLocalImageSrc.mockReturnValue(
    new Promise<string | null>((resolve) => {
      settle = resolve
    })
  )
  setNativeChatAttachmentNotes('agent-session:chip', 'img-1', {
    ...NOTES,
    notes: [{ id: 'n1', number: 1, text: 'Align', mark: { kind: 'pin', x: 0.5, y: 0.5 } }]
  })
  render(
    createElement(NativeChatImageAttachmentPreview, {
      attachment: { id: 'img-1', path: '/tmp/marked.png' },
      notesScopeKey: 'agent-session:chip',
      onRemove: () => {}
    })
  )
  fireEvent.click(screen.getByRole('button', { name: /View image/ }))
  // Opening on the marked copy first would seed the viewer without its notes.
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => settle(null))
  expect(screen.getByRole('dialog')).toBeTruthy()
})
