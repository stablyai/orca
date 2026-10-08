// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'

let pickAttachments: ReturnType<typeof vi.fn>
const onFileDrop = vi.fn()
function renderProbe(
  attachExternalPaths: (paths: string[]) => void
): () => { pickAttachments: () => void } {
  const { result } = renderHook(() => useNativeChatFileAttachmentActions(attachExternalPaths))
  return () => result.current
}

describe('useNativeChatFileAttachmentActions', () => {
  beforeEach(() => {
    onFileDrop.mockClear()
    pickAttachments = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        shell: { pickAttachments },
        ui: { onFileDrop }
      }
    })
  })

  afterEach(cleanup)

  it('attaches every path the picker returns, not just the first', async () => {
    pickAttachments.mockResolvedValue(['/picked/notes.md', '/picked/diagram.png'])
    const attachExternalPaths = vi.fn()
    const latest = renderProbe(attachExternalPaths)
    await act(async () => {
      latest().pickAttachments()
    })
    expect(attachExternalPaths).toHaveBeenCalledExactlyOnceWith([
      '/picked/notes.md',
      '/picked/diagram.png'
    ])
  })

  it('attaches nothing when the picker is canceled', async () => {
    pickAttachments.mockResolvedValue([])
    const attachExternalPaths = vi.fn()
    const latest = renderProbe(attachExternalPaths)
    await act(async () => {
      latest().pickAttachments()
    })
    // Whether the empty batch is forwarded or dropped here, no file may attach.
    expect(attachExternalPaths.mock.calls.flatMap(([paths]) => paths)).toEqual([])
  })

  it('does not subscribe to legacy window drops', () => {
    renderProbe(vi.fn())
    expect(onFileDrop).not.toHaveBeenCalled()
  })
})
