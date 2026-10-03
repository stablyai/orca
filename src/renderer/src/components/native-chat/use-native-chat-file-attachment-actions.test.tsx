// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  NATIVE_FILE_DROP_TARGET,
  type NativeFileDropPayload
} from '../../../../shared/native-file-drop'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'

const SCOPE_KEY = 'pane-1'

let pickAttachments: ReturnType<typeof vi.fn>
type DropListener = (payload: NativeFileDropPayload) => void

let dropListeners: DropListener[] = []
let root: Root | null = null

function Probe({
  attachExternalPaths,
  onReady
}: {
  attachExternalPaths: (paths: string[]) => void
  onReady: (api: { pickAttachments: () => void }) => void
}): null {
  onReady(useNativeChatFileAttachmentActions(SCOPE_KEY, attachExternalPaths))
  return null
}

async function renderProbe(
  attachExternalPaths: (paths: string[]) => void
): Promise<() => { pickAttachments: () => void }> {
  const container = document.createElement('div')
  document.body.append(container)
  let api: { pickAttachments: () => void } | null = null
  root = createRoot(container)
  await act(async () => {
    root?.render(
      createElement(Probe, {
        attachExternalPaths,
        onReady: (next) => {
          api = next
        }
      })
    )
  })
  return () => {
    if (!api) {
      throw new Error('probe never rendered')
    }
    return api
  }
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

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
  })

  it('attaches every path the picker returns, not just the first', async () => {
    pickAttachments.mockResolvedValue(['/picked/notes.md', '/picked/diagram.png'])
    const attachExternalPaths = vi.fn()
    const latest = await renderProbe(attachExternalPaths)
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
    const latest = await renderProbe(attachExternalPaths)
    await act(async () => {
      latest().pickAttachments()
    })
    // Whether the empty batch is forwarded or dropped here, no file may attach.
    expect(attachExternalPaths.mock.calls.flatMap(([paths]) => paths)).toEqual([])
  })

  it('only attaches a drop aimed at this pane', async () => {
    const attachExternalPaths = vi.fn()
    await renderProbe(attachExternalPaths)
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
