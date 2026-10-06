// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import {
  NATIVE_FILE_DROP_TARGET,
  type NativeFileDropPayload
} from '../../../../shared/native-file-drop'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'

const SCOPE_KEY = 'pane-1'

let pickAttachments: ReturnType<typeof vi.fn>
type DropListener = (payload: NativeFileDropPayload) => void

let dropListeners: DropListener[] = []
function renderProbe(
  attachExternalPaths: (paths: string[]) => void
): () => { pickAttachments: () => void } {
  const { result } = renderHook(() =>
    useNativeChatFileAttachmentActions(SCOPE_KEY, attachExternalPaths)
  )
  return () => result.current
}

describe('useNativeChatFileAttachmentActions', () => {
  beforeEach(() => {
    dropListeners = []
    pickAttachments = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        shell: { pickAttachments },
        ui: {
          onFileDrop: (listener: DropListener) => {
            dropListeners.push(listener)
            return () => {
              dropListeners = dropListeners.filter((entry) => entry !== listener)
            }
          }
        }
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

  it('only attaches a drop aimed at this pane', async () => {
    const attachExternalPaths = vi.fn()
    renderProbe(attachExternalPaths)
    await act(async () => {
      for (const listener of dropListeners) {
        listener({
          target: NATIVE_FILE_DROP_TARGET.composer,
          scopeKey: 'other-pane',
          paths: ['/dropped/a.png']
        })
        listener({
          target: NATIVE_FILE_DROP_TARGET.composer,
          scopeKey: SCOPE_KEY,
          paths: ['/dropped/a.png', '/dropped/b.png']
        })
      }
    })
    expect(attachExternalPaths).toHaveBeenCalledExactlyOnceWith([
      '/dropped/a.png',
      '/dropped/b.png'
    ])
  })
})
