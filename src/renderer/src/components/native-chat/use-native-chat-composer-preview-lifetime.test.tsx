// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type AttachmentApi = ReturnType<typeof useNativeChatComposerAttachments>
const roots = new Set<Root>()

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))

async function mount(scopeKey: string) {
  let latest: AttachmentApi | null = null
  function Probe(): null {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    latest = useNativeChatComposerAttachments({
      attachmentScopeKey: scopeKey,
      allowWithoutTarget: true,
      caret: 0,
      disabled: false,
      isComposing: () => false,
      resolveTarget: () => null,
      textareaRef,
      setCaret: () => {},
      setDraft: () => {},
      setNotice: () => {}
    })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.add(root)
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))))
  return {
    api: (): AttachmentApi => {
      if (!latest) {
        throw new Error('Composer did not mount')
      }
      return latest
    },
    unmount: () => {
      act(() => root.unmount())
      roots.delete(root)
      container.remove()
    }
  }
}

function begin(api: AttachmentApi, previewUrl: string): string {
  const id = api.beginPendingImageAttachment(previewUrl)
  if (!id) {
    throw new Error('Attachment was refused')
  }
  return id
}

afterEach(() => {
  act(() => {
    for (const root of roots) {
      root.unmount()
    }
  })
  roots.clear()
  clearNativeChatAttachmentCacheForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('composer preview lifetime', () => {
  it.each([null, 'ssh-connection'])(
    'releases settled previews while retaining saved paths (%s)',
    async (connectionId) => {
      const revoke = vi.spyOn(URL, 'revokeObjectURL')
      const first = await mount('preview-scope')
      act(() => {
        const id = begin(first.api(), 'blob:clipboard-preview')
        first.api().resolvePendingImageAttachment(id, '/workspace/image.png', connectionId)
      })
      expect(first.api().imageAttachments).toMatchObject([
        { path: '/workspace/image.png', previewUrl: 'blob:clipboard-preview' }
      ])
      expect(revoke).not.toHaveBeenCalled()
      const saved = readNativeChatAttachmentCache('preview-scope')

      first.unmount()
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:clipboard-preview')
      expect(readNativeChatAttachmentCache('preview-scope')).toEqual(saved)
      const restored = await mount('preview-scope')
      expect(restored.api().imageAttachments).toEqual(saved)
      expect(saved[0]?.connectionId).toBe(connectionId ?? undefined)
      restored.unmount()
      expect(revoke).toHaveBeenCalledTimes(1)
    }
  )

  it('releases pending previews without turning them into saved attachments', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const composer = await mount('pending-scope')
    act(() => begin(composer.api(), 'blob:pending-preview'))
    composer.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:pending-preview')
    expect(readNativeChatAttachmentCache('pending-scope')).toEqual([])
  })

  it('does not revoke data previews or saved paths', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const composer = await mount('data-scope')
    act(() => {
      const id = begin(composer.api(), 'data:image/png;base64,AAAA')
      composer.api().resolvePendingImageAttachment(id, '/workspace/image.png')
    })
    composer.unmount()
    expect(revoke).not.toHaveBeenCalled()
    expect(readNativeChatAttachmentCache('data-scope')).toMatchObject([
      { path: '/workspace/image.png' }
    ])
  })

  it('does not retain previews that were already removed or cleared', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const composer = await mount('cleared-scope')
    act(() => {
      const id = begin(composer.api(), 'blob:removed')
      composer.api().dropPendingImageAttachment(id)
      const keptId = begin(composer.api(), 'blob:cleared')
      composer.api().resolvePendingImageAttachment(keptId, '/workspace/image.png')
    })
    act(() => composer.api().clearImageAttachments())
    expect(revoke).toHaveBeenCalledTimes(2)
    composer.unmount()
    expect(revoke).toHaveBeenCalledTimes(2)
  })
})
