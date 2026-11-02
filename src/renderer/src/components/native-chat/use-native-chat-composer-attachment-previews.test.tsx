// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useNativeChatComposerAttachmentPreviews } from './use-native-chat-composer-attachment-previews'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

type PreviewApi = ReturnType<typeof useNativeChatComposerAttachmentPreviews>
const roots = new Set<Root>()

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))

async function mount(
  settled: readonly NativeChatComposerImageAttachment[] = [],
  pending: readonly NativeChatComposerImageAttachment[] = []
) {
  let latest: PreviewApi | null = null
  function Probe(): null {
    latest = useNativeChatComposerAttachmentPreviews(settled, pending)
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.add(root)
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe))))
  return {
    api: (): PreviewApi => {
      if (!latest) {
        throw new Error('Preview owner did not mount')
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

afterEach(() => {
  act(() => {
    for (const root of roots) {
      root.unmount()
    }
  })
  roots.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('composer preview ownership', () => {
  it('releases pending and settled local previews without changing their attachments', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const settled = [{ id: 'settled', path: '/workspace/image.png', connectionId: 'ssh' }]
    const pending = [{ id: 'pending', path: '', pending: true }]
    const owner = await mount(settled, pending)
    act(() => {
      owner.api().setPreview('settled', 'blob:settled')
      owner.api().setPreview('pending', 'blob:pending')
    })
    expect(owner.api().previews.size).toBe(2)
    expect(revoke).not.toHaveBeenCalled()
    owner.unmount()
    expect(revoke.mock.calls).toEqual([['blob:settled'], ['blob:pending']])
    expect(settled).toEqual([{ id: 'settled', path: '/workspace/image.png', connectionId: 'ssh' }])
    expect(pending).toEqual([{ id: 'pending', path: '', pending: true }])
    const restored = await mount(settled, pending)
    expect(restored.api().previews.size).toBe(0)
    restored.unmount()
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  it('keeps simultaneous composers independent', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const pending = [{ id: 'pending', path: '', pending: true }]
    const first = await mount([], pending)
    const second = await mount([], pending)
    act(() => {
      first.api().setPreview('pending', 'blob:first')
      second.api().setPreview('pending', 'blob:second')
    })
    first.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:first')
    expect(second.api().previews.get('pending')).toBe('blob:second')
    second.unmount()
    expect(revoke.mock.calls).toEqual([['blob:first'], ['blob:second']])
  })

  it('releases a preview arriving after its composer retired', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const owner = await mount()
    const retiredApi = owner.api()
    owner.unmount()
    retiredApi.setPreview('late', 'blob:late')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:late')
    retiredApi.releasePreview('late')
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:late')
  })

  it('does not revoke data URLs or already released previews', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const pending = [
      { id: 'removed', path: '', pending: true },
      { id: 'cleared', path: '', pending: true },
      { id: 'data', path: '', pending: true }
    ]
    const owner = await mount([], pending)
    act(() => {
      owner.api().setPreview('removed', 'blob:removed')
      owner.api().setPreview('cleared', 'blob:cleared')
      owner.api().setPreview('data', 'data:image/png;base64,AAAA')
      owner.api().releasePreview('removed')
      owner.api().releaseAllPreviews()
    })
    expect(revoke.mock.calls).toEqual([['blob:removed'], ['blob:cleared']])
    owner.unmount()
    expect(revoke).toHaveBeenCalledTimes(2)
    owner.api().setPreview('data', 'data:image/png;base64,AAAA')
    expect(revoke).toHaveBeenCalledTimes(2)
  })
})
