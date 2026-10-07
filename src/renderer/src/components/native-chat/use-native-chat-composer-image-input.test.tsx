// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  clearNativeChatAttachmentCacheForTests,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type AttachmentApi = ReturnType<typeof useNativeChatComposerAttachments>

function Probe(props: {
  acceptsImages: boolean
  onReady: (api: AttachmentApi) => void
}): React.JSX.Element {
  const [caret, setCaret] = useState(0)
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: 'structured-session',
    allowWithoutTarget: true,
    acceptsImages: props.acceptsImages,
    caret,
    disabled: false,
    isComposing: () => false,
    resolveTarget: () => null,
    textareaRef,
    setCaret,
    setDraft: (updater) => setDraft((previous) => updater(previous)),
    setNotice: () => {}
  })
  const { onReady } = props
  useEffect(() => {
    onReady(api)
  }, [api, onReady])
  return createElement('div', null, [
    createElement('textarea', { key: 'input', ref: textareaRef }),
    createElement('output', { key: 'draft', 'data-draft': true }, draft)
  ])
}

async function attach(acceptsImages: boolean, path: string) {
  const container = document.createElement('div')
  document.body.append(container)
  let api: AttachmentApi | null = null
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(Probe, {
        acceptsImages,
        onReady: (next) => {
          api = next
        }
      })
    )
  })
  const latest = (): AttachmentApi => {
    if (!api) {
      throw new Error('Probe did not render')
    }
    return api
  }
  const pendingChip = latest().beginPendingImageAttachment('blob:preview')
  await act(async () => latest().attachResolvedPaths([path]))
  const result = {
    chips: latest().imageAttachments.map((attachment) => attachment.path),
    pendingChip,
    draft: container.querySelector('[data-draft]')?.textContent ?? ''
  }
  act(() => root.unmount())
  return result
}

describe('structured composer image input', () => {
  afterEach(() => {
    clearNativeChatAttachmentCacheForTests()
    document.body.replaceChildren()
  })

  it('holds an image as a chip when the agent takes images', async () => {
    const result = await attach(true, '/tmp/shot.png')
    expect(result.chips).toContain('/tmp/shot.png')
    expect(result.pendingChip).not.toBeNull()
  })

  it('references an image by path, with no chip, when the agent takes none', async () => {
    const result = await attach(false, '/tmp/shot.png')
    expect(result.chips).toEqual([])
    expect(result.pendingChip).toBeNull()
    expect(result.draft).toContain('/tmp/shot.png')
  })

  it('still shows a named upload chip when the agent takes no images', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    let api: AttachmentApi | null = null
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(Probe, {
          acceptsImages: false,
          onReady: (next) => {
            api = next
          }
        })
      )
    })
    const latest = (): AttachmentApi => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    }
    expect(latest().beginPendingImageAttachment(undefined, 'notes.txt')).not.toBeNull()
    act(() => root.unmount())
  })
})
