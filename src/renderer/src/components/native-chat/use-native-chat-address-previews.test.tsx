// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAddressPreviewResult } from '../../../../shared/chat-address-preview'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useNativeChatAddressPreviews } from './use-native-chat-address-previews'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
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
      const inputRef = { current: { value: source } as NativeChatComposerInput }
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
