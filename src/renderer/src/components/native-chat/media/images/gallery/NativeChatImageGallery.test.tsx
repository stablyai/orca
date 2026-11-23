// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeChatImageAttachments } from '../NativeChatImageAttachments'
import { NativeChatMarkdownImage } from '../NativeChatMarkdownImage'
import { NativeChatMarkdownImageOwnerContext } from '../native-chat-markdown-image-owner'
import {
  NativeChatGalleryCoveredFocusContext,
  NativeChatGalleryMessageContext
} from './native-chat-image-gallery-context'
import { NativeChatImageGallery } from './NativeChatImageGallery'
import { readLocalImagePreview } from '@/components/editor/document-images/local-image-src-reader'
import {
  invalidateLocalImageCache,
  resetLocalImageCacheState
} from '@/components/editor/document-images/local-image-src-cache'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'

vi.mock('@/components/editor/document-images/local-image-src-reader', () => ({
  readLocalImagePreview: vi.fn()
}))
vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

const LOCAL: RuntimeFileOperationArgs = {
  target: { kind: 'local' },
  worktreeId: 'w',
  worktreePath: '/w'
}

beforeEach(() => {
  // No observer: every tile counts as near the viewport and shows its image.
  vi.stubGlobal('IntersectionObserver', undefined)
  const rect = new DOMRect(0, 0, 80, 80)
  const rects: DOMRectList = {
    length: 1,
    0: rect,
    item: (index) => (index === 0 ? rect : null),
    [Symbol.iterator]: () => [rect][Symbol.iterator]()
  }
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue(rects)
})

afterEach(() => {
  cleanup()
  resetLocalImageCacheState()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const OWNER = { fileLinkContext: null, runtimeContext: null, isVisible: true, sessionId: 'session' }

function image(name: string, url = `https://example.invalid/${name}`) {
  return { type: 'image-ref' as const, url, alt: name }
}

type Message = {
  id: string | null
  images: (ReturnType<typeof image> | { type: 'image-ref'; path: string })[]
}

const coveringView = () => document.getElementById('covering-view')

function Chat({
  messages,
  loaded = messages.flatMap(({ id }) => (id ? [id] : [])),
  covered = false
}: {
  messages: Message[]
  loaded?: string[]
  /** A subagent view drawn over the list, which makes it inert. */
  covered?: boolean
}): React.JSX.Element {
  return (
    <NativeChatMarkdownImageOwnerContext value={OWNER}>
      <NativeChatGalleryCoveredFocusContext value={coveringView}>
        <NativeChatImageGallery loadedMessageIds={new Set(loaded)}>
          <div inert={covered} data-native-chat-gallery-root="">
            {messages.map((message, at) => (
              <NativeChatGalleryMessageContext key={at} value={message.id}>
                <NativeChatImageAttachments blocks={message.images} runtimeContext={LOCAL} />
              </NativeChatGalleryMessageContext>
            ))}
          </div>
        </NativeChatImageGallery>
      </NativeChatGalleryCoveredFocusContext>
      <button type="button" id="covering-view">
        covering view
      </button>
    </NativeChatMarkdownImageOwnerContext>
  )
}

const dialog = () => screen.getByRole('dialog')
const shown = () => dialog().querySelector('img')?.getAttribute('alt')
const open = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: `View image: ${name}` }))
const right = () => fireEvent.keyDown(dialog(), { key: 'ArrowRight' })

it("steps on past a message's last image into the next message", () => {
  render(
    <Chat
      messages={[
        { id: 'first', images: [image('a.png'), image('b.png')] },
        { id: 'second', images: [image('c.png')] }
      ]}
    />
  )
  open('a.png')
  right()
  expect(shown()).toBe('b.png')
  right()
  expect(shown()).toBe('c.png')
})

it('leaves out pending rows, skips unloaded messages and closes when the shown one goes', () => {
  const messages: Message[] = [
    { id: 'first', images: [image('a.png')] },
    { id: null, images: [image('pending.png')] },
    { id: 'second', images: [image('b.png')] },
    { id: 'third', images: [image('c.png')] }
  ]
  const { rerender } = render(<Chat messages={messages} />)
  open('a.png')
  right()
  expect(shown()).toBe('b.png')

  rerender(<Chat messages={messages} loaded={['first', 'second']} />)
  expect(screen.getByRole('button', { name: 'Next image' }).hasAttribute('disabled')).toBe(true)
  rerender(<Chat messages={messages} loaded={['first']} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps focus on an arrow when stepping to the end', () => {
  render(
    <Chat
      messages={[
        { id: 'first', images: [image('a.png')] },
        { id: 'second', images: [image('b.png')] }
      ]}
    />
  )
  open('a.png')
  const next = screen.getByRole('button', { name: 'Next image' })
  next.focus()
  fireEvent.click(next)
  expect(shown()).toBe('b.png')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Previous image')
})

it('shows a repeated image afresh and keeps one live region across steps', () => {
  const same = 'https://example.invalid/same.png'
  render(
    <Chat
      messages={[
        { id: 'first', images: [image('one.png', same)] },
        { id: 'second', images: [image('two.png', same)] }
      ]}
    />
  )
  open('one.png')
  const before = dialog().querySelector('img')
  const regions = () => dialog().querySelectorAll('[aria-live]')
  expect(regions()).toHaveLength(1)
  const live = regions()[0]
  act(() => right())
  expect(shown()).toBe('two.png')
  expect(dialog().querySelector('img')).not.toBe(before)
  expect(regions()).toHaveLength(1)
  expect(regions()[0]).toBe(live)
  expect(live.textContent).toBe('Image 2 of 2 in this view: two.png. Last image.')
})

it('shows an image that will not decode as unavailable and offers no copy of it', () => {
  render(
    <Chat
      messages={[
        { id: 'first', images: [image('a.png')] },
        { id: 'second', images: [image('broken.png')] }
      ]}
    />
  )
  open('a.png')
  right()
  const broken = dialog().querySelector('img')
  if (!broken) {
    throw new Error('expected the broken image to be shown')
  }
  expect(broken.getAttribute('alt')).toBe('broken.png')
  fireEvent.error(broken)
  expect(dialog().querySelector('img')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe("Couldn't load broken.png")
  expect(dialog().hasAttribute('data-native-chat-copy-image-src')).toBe(false)
})

it('hands focus to a view that covers the list while the viewer has it', async () => {
  const messages: Message[] = [
    { id: 'first', images: [image('a.png')] },
    { id: 'second', images: [image('b.png')] }
  ]
  const { rerender } = render(<Chat messages={messages} />)
  open('a.png')
  dialog().focus()
  rerender(<Chat messages={messages} covered />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement?.id).toBe('covering-view')
})

it('tries an image again once a reread brings a new payload after one would not decode', async () => {
  vi.mocked(readLocalImagePreview).mockResolvedValue({
    content: 'AAAA',
    isBinary: true,
    mimeType: 'image/png'
  })
  render(
    <Chat
      messages={[
        { id: 'first', images: [image('a.png')] },
        { id: 'second', images: [{ type: 'image-ref', path: '/w/shot.png' }] }
      ]}
    />
  )
  await act(async () => {})
  open('a.png')
  right()
  const first = dialog().querySelector('img')
  if (!first) {
    throw new Error('expected the local image to be shown')
  }
  fireEvent.error(first)
  expect(screen.getByRole('status')).toBeTruthy()
  expect(dialog().hasAttribute('data-native-chat-copy-image-src')).toBe(false)

  await act(async () => invalidateLocalImageCache())
  await act(async () => {})
  const reread = dialog().querySelector('img')
  if (!reread) {
    throw new Error('expected the reread image to be shown')
  }
  expect(reread.getAttribute('src')).not.toBe(first.getAttribute('src'))
  expect(dialog().hasAttribute('data-native-chat-copy-image-src')).toBe(false)
  fireEvent.load(reread)
  expect(dialog().getAttribute('data-native-chat-copy-image-src')).toBe(reread.getAttribute('src'))
})

it('offers Copy only once the shown image has loaded, and again after each step', () => {
  render(
    <Chat
      messages={[
        { id: 'first', images: [image('a.png')] },
        { id: 'second', images: [image('b.png')] }
      ]}
    />
  )
  open('a.png')
  const copySrc = () => dialog().getAttribute('data-native-chat-copy-image-src')
  const shownImage = () => {
    const img = dialog().querySelector('img')
    if (!img) {
      throw new Error('expected an image to be shown')
    }
    return img
  }
  expect(copySrc()).toBeNull()
  fireEvent.load(shownImage())
  expect(copySrc()).toBe('https://example.invalid/a.png')

  right()
  expect(shown()).toBe('b.png')
  expect(copySrc()).toBeNull()
  fireEvent.load(shownImage())
  expect(copySrc()).toBe('https://example.invalid/b.png')
})

function MarkdownChat({ messages }: { messages: { id: string; src: string; alt?: string }[] }) {
  return (
    <NativeChatMarkdownImageOwnerContext value={OWNER}>
      <NativeChatImageGallery loadedMessageIds={new Set(messages.map(({ id }) => id))}>
        <div data-native-chat-gallery-root="">
          {messages.map((message) => (
            <NativeChatGalleryMessageContext key={message.id} value={message.id}>
              <NativeChatMarkdownImage src={message.src} alt={message.alt} />
            </NativeChatGalleryMessageContext>
          ))}
        </div>
      </NativeChatImageGallery>
    </NativeChatMarkdownImageOwnerContext>
  )
}

it('names a Markdown image that fails in the viewer', () => {
  render(
    <MarkdownChat
      messages={[
        { id: 'first', src: 'https://example.invalid/a.png', alt: 'a.png' },
        { id: 'second', src: 'https://example.invalid/diagram.png', alt: 'diagram.png' }
      ]}
    />
  )
  open('a.png')
  right()
  const broken = dialog().querySelector('img')
  if (!broken) {
    throw new Error('expected the Markdown image to be shown')
  }
  fireEvent.error(broken)
  expect(screen.getByRole('status').textContent).toBe("Couldn't load diagram.png")
})

it('leaves GitHub attachment images out of the image set', () => {
  render(
    <MarkdownChat
      messages={[
        { id: 'first', src: 'https://example.invalid/a.png', alt: 'a.png' },
        {
          id: 'second',
          src: 'https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000',
          alt: 'attachment.png'
        }
      ]}
    />
  )
  expect(document.querySelectorAll('[data-native-chat-gallery-item]')).toHaveLength(1)
  open('a.png')
  // A lone image shows no arrows: the attachment is not a step away.
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull()
})
