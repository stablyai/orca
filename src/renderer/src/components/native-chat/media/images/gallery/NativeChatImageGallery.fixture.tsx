// A tab chat's images across three messages, opened in the stepping viewer: the count, the long
// title squeeze, loading and unavailable images, and messages removed while it is open.
import { useState } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { Toaster } from '../../../../ui/sonner'
import { NativeChatImageAttachments } from '../NativeChatImageAttachments'
import { NativeChatMarkdownImageOwnerContext } from '../native-chat-markdown-image-owner'
import { NativeChatGalleryMessageContext } from './native-chat-image-gallery-context'
import { NativeChatImageGallery } from './NativeChatImageGallery'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'

const OWNER = { fileLinkContext: null, runtimeContext: null, isVisible: true, sessionId: 'fixture' }
const LOCAL: RuntimeFileOperationArgs = {
  target: { kind: 'local' },
  worktreeId: 'fixture',
  worktreePath: '/fixture'
}
const COLORS = ['#2563eb', '#16a34a', '#9333ea', '#ea580c']
const LONG = 'checkout-form-validation-after-submitting-the-shipping-address'

function picture(at: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${COLORS[at % 4]}"/><text x="320" y="215" font-family="sans-serif" font-size="56" fill="white" text-anchor="middle">image ${at + 1}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function shot(at: number, long: boolean) {
  const alt = long ? `${LONG}-step-${at + 1}.png` : `step-${at + 1}.png`
  return { type: 'image-ref' as const, url: picture(at), alt }
}

type Layout = { messages: number[][]; long?: boolean; local?: number; localName?: string }

function Chat({ messages, long = false, local, localName = 'local' }: Layout): React.JSX.Element {
  const [loaded, setLoaded] = useState(() => messages.map((_, at) => `message-${at}`))
  return (
    <NativeChatMarkdownImageOwnerContext value={OWNER}>
      <NativeChatImageGallery loadedMessageIds={new Set(loaded)}>
        <div data-native-chat-gallery-root="" className="flex flex-col gap-3 p-4">
          {messages.map((images, at) => (
            <NativeChatGalleryMessageContext key={at} value={`message-${at}`}>
              <NativeChatImageAttachments
                runtimeContext={LOCAL}
                blocks={images.map((image) =>
                  image === local
                    ? {
                        type: 'image-ref' as const,
                        path: `/fixture/${localName}-step-${image + 1}.png`
                      }
                    : shot(image, long)
                )}
              />
            </NativeChatGalleryMessageContext>
          ))}
          <button
            type="button"
            data-fixture-remove
            className="hidden"
            onClick={(event) => {
              const id = event.currentTarget.dataset.fixtureRemove
              setLoaded((current) => current.filter((message) => message !== id))
            }}
          />
        </div>
      </NativeChatImageGallery>
      <div className="h-[760px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </NativeChatMarkdownImageOwnerContext>
  )
}

const ACROSS = [[0], [1, 2], [3]]

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
}

async function open(name: string): Promise<void> {
  const deadline = performance.now() + 5000
  let button = document.querySelector<HTMLButtonElement>(`button[aria-label$="${name}"]`)
  while (!button && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    button = document.querySelector<HTMLButtonElement>(`button[aria-label$="${name}"]`)
  }
  button?.click()
}

function step(which: 'previous' | 'next'): void {
  document.querySelector<HTMLButtonElement>(`[data-image-step="${which}"]`)?.click()
}

function remove(message: string): void {
  const button = document.querySelector<HTMLButtonElement>('[data-fixture-remove]')
  if (button) {
    button.dataset.fixtureRemove = message
    button.click()
  }
}

function opened(width: number, layout: Layout, name: string) {
  return defineFixture({
    width,
    render: () => <Chat {...layout} />,
    interact: async () => {
      await open(name)
      await settle()
    }
  })
}

export const middle360 = opened(360, { messages: ACROSS }, 'step-2.png')
export const middle640 = opened(640, { messages: ACROSS }, 'step-2.png')
export const middle1280 = opened(1280, { messages: ACROSS }, 'step-2.png')
export const longTitle360 = opened(360, { messages: ACROSS, long: true }, 'step-2.png')
export const longTitle640 = opened(640, { messages: ACROSS, long: true }, 'step-2.png')
export const oneMessage640 = opened(640, { messages: [[0, 1, 2]] }, 'step-2.png')

/** The last image, reached with the Next arrow: focus moves to Previous. */
export const lastImage640 = defineFixture({
  width: 640,
  render: () => <Chat messages={ACROSS} />,
  interact: async () => {
    await open('step-3.png')
    await settle()
    document.querySelector<HTMLButtonElement>('[data-image-step="next"]')?.focus()
    step('next')
    await settle()
  }
})

/** A local image whose read is still pending, stepped to from its neighbour. */
export const loading640 = defineFixture({
  width: 640,
  setup: () => {
    window.api.fs.readFile = () => new Promise<never>(() => {})
  },
  render: () => <Chat messages={ACROSS} local={2} localName="pending" />,
  interact: async () => {
    await open('step-2.png')
    await settle()
    step('next')
    await settle()
  }
})

/** A local image that cannot be read. */
export const unavailable640 = defineFixture({
  width: 640,
  setup: () => {
    window.api.fs.readFile = () => Promise.reject(new Error('fixture: unreadable'))
  },
  render: () => <Chat messages={ACROSS} local={2} localName="unreadable" />,
  interact: async () => {
    await open('step-2.png')
    await settle()
    step('next')
    await settle()
  }
})

/** The next image's message is removed while open: the count shrinks and Next skips it. */
export const removedNext640 = defineFixture({
  width: 640,
  render: () => <Chat messages={ACROSS} />,
  interact: async () => {
    await open('step-1.png')
    await settle()
    remove('message-1')
    await settle()
  }
})

/** The shown image's message is removed: the viewer closes and says why. */
export const removedShown640 = defineFixture({
  width: 640,
  render: () => <Chat messages={ACROSS} />,
  interact: async () => {
    await open('step-1.png')
    await settle()
    remove('message-0')
    await settle()
    await settle()
  }
})
