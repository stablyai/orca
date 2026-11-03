// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAddressPreviewResult } from '../../../../shared/chat-address-preview'
import { useNativeChatAddressPreviews } from './use-native-chat-address-previews'
import { useNativeChatComposerHandle } from './use-native-chat-composer-handle'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { clearNativeChatComposerDraftsForTests } from './native-chat-composer-draft-store'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  nativeChatPastedTextOperations.clear()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('address preview visibility and conversation lifetime', () => {
  it.each(['hidden', 'conversation change'] as const)(
    'releases a pending preview on %s and does not restore it from retained draft text',
    async (transition) => {
      const pending = Promise.withResolvers<ChatAddressPreviewResult>()
      const previewAddress = vi.fn(() => pending.promise)
      const releaseAddressPreview = vi.fn(async () => {})
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { fs: { previewAddress, releaseAddressPreview } }
      })
      const source = '/tmp/recording.wav'
      const input = document.createElement('textarea')
      input.value = source
      const inputRef = { current: input }
      const view = renderHook(
        ({ scopeKey, enabled }) =>
          useNativeChatAddressPreviews({ scopeKey, enabled, draft: source, inputRef }),
        { initialProps: { scopeKey: 'conversation-a', enabled: true } }
      )
      act(() => view.result.current.onTextPasted(source))
      const id = view.result.current.entries[0].id
      view.rerender({
        scopeKey: transition === 'conversation change' ? 'conversation-b' : 'conversation-a',
        enabled: transition !== 'hidden'
      })
      expect(view.result.current.entries).toEqual([])
      expect(releaseAddressPreview).toHaveBeenCalledWith({ id })
      await act(async () => {
        pending.resolve({
          status: 'ready',
          id,
          name: 'recording.wav',
          kind: 'audio',
          mimeType: 'audio/wav',
          url: 'orca-chat-preview://resource/obsolete'
        })
        await pending.promise
      })
      view.rerender({ scopeKey: 'conversation-a', enabled: true })
      expect(view.result.current.entries).toEqual([])
      expect(inputRef.current.value).toBe(source)
      expect(previewAddress).toHaveBeenCalledTimes(1)
    }
  )
})

it.each([false, true])(
  'keeps inline address previews and long-paste file routing together (long=%s)',
  async (long) => {
    const source = long ? `https://example.com/${'a'.repeat(33 * 1024)}.txt` : '/tmp/notes.md'
    const savePastedTextAsFile = vi.fn(async () => '/tmp/pasted-text.txt')
    const previewAddress = vi.fn(async ({ id }: { id: string }) => ({
      status: 'ready' as const,
      id,
      name: 'notes.md',
      kind: 'markdown' as const,
      mimeType: 'text/markdown',
      content: '# Notes'
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fs: { previewAddress, releaseAddressPreview: async () => {} },
        ui: { savePastedTextAsFile }
      }
    })
    const input: NativeChatComposerInput = Object.assign(document.createElement('textarea'), {
      insertText: (text: string) => {
        input.value += text
      },
      stagePastedText: (token: string) => {
        input.value += token
      }
    })
    const textareaRef = { current: input }
    const view = renderHook(() =>
      useNativeChatComposerHandle(null, {
        textareaRef,
        draft: '',
        addressPreviewsEnabled: true,
        attachmentScopeKey: 'preview-paste-integration',
        targetKey: 'session-a',
        isComposing: () => false,
        setDraft: () => {},
        setCaret: () => {},
        setActiveSuggestion: () => {},
        disabled: false,
        caret: 0,
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        attachResolvedPaths: () => {},
        attachCopiedFiles: () => {},
        captureCopiedFiles: () => async () => {},
        beginPendingImageAttachment: () => null,
        resolvePendingImageAttachment: () => {},
        dropPendingImageAttachment: () => {},
        pastedTextEditor: () => input,
        setNotice: () => {}
      })
    )
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', source)
    await act(async () => {
      view.result.current.handlePasteEvent(
        new ClipboardEvent('paste', { clipboardData, cancelable: true })
      )
    })
    if (long) {
      expect(input.value).not.toContain(source)
      expect(input.value).toContain('orca-paste:')
      expect(savePastedTextAsFile).toHaveBeenCalledWith({ text: source })
      expect(view.result.current.addressPreviews.entries).toEqual([])
      expect(previewAddress).not.toHaveBeenCalled()
    } else {
      expect(input.value).toBe(source)
      expect(view.result.current.addressPreviews.entries).toHaveLength(1)
      expect(savePastedTextAsFile).not.toHaveBeenCalled()
    }
  }
)
