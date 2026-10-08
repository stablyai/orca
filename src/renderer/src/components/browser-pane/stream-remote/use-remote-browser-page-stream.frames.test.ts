// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../../../shared/browser-screencast-protocol'
import type { RemoteBrowserStreamBridge } from './remote-browser-page-input-model'
import {
  createGate,
  createHarness,
  openStreamAndConfirmReady,
  settle
} from './remote-browser-stream-lifecycle-test-harness'
import { useRemoteBrowserPageStream } from './use-remote-browser-page-stream'

vi.mock('./use-remote-browser-stream-activation', () => ({
  useRemoteBrowserStreamActivation: () => {}
}))

function frame(seq: number): Uint8Array {
  return encodeBrowserScreencastFrame({
    opcode: BrowserScreencastOpcode.Frame,
    seq,
    format: 'jpeg',
    metadata: { timestamp: seq, imageWidth: 800, imageHeight: 600 },
    image: new Uint8Array([seq])
  })
}

function renderStream() {
  const decodes: { image: HTMLImageElement; gate: ReturnType<typeof createGate> }[] = []
  vi.spyOn(window, 'Image').mockImplementation(function () {
    const image = document.createElement('img')
    const gate = createGate()
    Object.defineProperty(image, 'decode', { value: () => gate.wait })
    decodes.push({ image, gate })
    return image
  })
  let urlSequence = 0
  const createUrl = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation(() => `blob:frame-${++urlSequence}`)
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const setFrameUrl = vi.fn()
  const setFrameMetadata = vi.fn()
  const streamFrameUrlRef: { current: string | null } = { current: null }
  const pendingFrameDecodeRef = { current: 0 }
  const clearFrame = (): void => {
    pendingFrameDecodeRef.current += 1
    if (streamFrameUrlRef.current) {
      URL.revokeObjectURL(streamFrameUrlRef.current)
      streamFrameUrlRef.current = null
    }
  }
  const streamBridgeRef: { current: RemoteBrowserStreamBridge } = {
    current: {
      applyTabInfo: () => {},
      clearFrame,
      handleFrameBytes: () => {},
      closeMissingRemotePage: () => {},
      waitForViewportSize: async () => null,
      syncViewport: async () => {}
    }
  }
  const harness = createHarness({
    handleFrameBytes: (token, bytes, signal) =>
      streamBridgeRef.current.handleFrameBytes(token, bytes, signal),
    clearFrame
  })
  const view = renderHook(() =>
    useRemoteBrowserPageStream({
      activeRuntimeEnvironmentId: 'env-1',
      browserPageId: 'page-1',
      isActive: false,
      lifecycle: harness.lifecycle,
      stagedPage: false,
      runtimeWorktree: 'worktree:wt-1',
      runtimeTarget: () => null,
      remoteViewportRef: { current: null },
      remoteViewportSizeRef: { current: null },
      remoteCssViewportSizeRef: { current: null },
      remoteViewportTimerRef: { current: null },
      streamFrameUrlRef,
      pendingFrameDecodeRef,
      streamBridgeRef,
      isActiveRef: { current: false },
      applyTabInfo: () => {},
      clearStreamFrame: clearFrame,
      closeMissingRemotePage: () => {},
      clearPendingRemoteWheel: () => {},
      setPaneNotice: () => {},
      setPaneBusy: () => {},
      setFrameUrl,
      setFrameMetadata
    })
  )
  return { harness, view, decodes, createUrl, revokeUrl, setFrameUrl, setFrameMetadata, clearFrame }
}

describe('remote browser stream frame publication', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('publishes decoded frames during a burst and allocates URLs only for admitted images', async () => {
    const test = renderStream()
    await openStreamAndConfirmReady(test.harness)
    const stream = test.harness.streams[0]
    await act(async () => {
      for (let seq = 1; seq <= 120; seq += 1) {
        stream.emitFrame(frame(seq))
      }
    })
    expect(test.decodes).toHaveLength(1)
    expect(test.createUrl).toHaveBeenCalledTimes(1)
    await act(async () => {
      test.decodes[0].gate.release()
      await settle()
    })
    expect(test.setFrameUrl.mock.calls).toEqual([['blob:frame-1']])
    expect(test.setFrameMetadata.mock.calls[0][0].timestamp).toBe(1)
    expect(test.decodes).toHaveLength(2)
    await act(async () => {
      test.decodes[1].gate.release()
      await settle()
    })
    expect(test.setFrameMetadata.mock.calls.map(([metadata]) => metadata.timestamp)).toEqual([
      1, 120
    ])
    expect(test.createUrl).toHaveBeenCalledTimes(2)
    expect(test.revokeUrl.mock.calls).toEqual([['blob:frame-1']])
    test.clearFrame()
    expect(test.revokeUrl.mock.calls).toEqual([['blob:frame-1'], ['blob:frame-2']])
    test.harness.lifecycle.dispose()
  })

  it.each(['viewport', 'close', 'dispose', 'transport-error'] as const)(
    'cancels temporary image ownership on %s retirement',
    async (kind) => {
      const test = renderStream()
      await openStreamAndConfirmReady(test.harness)
      const oldStream = test.harness.streams[0]
      await act(async () => {
        oldStream.emitFrame(frame(1))
        oldStream.emitFrame(frame(2))
        if (kind === 'viewport') {
          test.harness.setViewportSize({ width: 1200, height: 800 })
          test.harness.lifecycle.restartForViewport('page-1')
        } else if (kind === 'close') {
          oldStream.emitClose()
        } else if (kind === 'transport-error') {
          oldStream.emitTransportError('connection-lost', 'Connection lost')
        } else {
          test.harness.identity.mounted = false
          test.harness.lifecycle.dispose()
        }
        await settle()
      })
      expect(test.decodes[0].image.hasAttribute('src')).toBe(false)
      expect(test.revokeUrl.mock.calls).toEqual([['blob:frame-1']])
      await act(async () => {
        test.decodes[0].gate.release()
        if (kind !== 'transport-error') {
          oldStream.emitFrame(frame(3))
        }
        await settle()
      })
      expect(test.setFrameUrl).not.toHaveBeenCalled()
      expect(test.createUrl).toHaveBeenCalledTimes(1)
      if (kind === 'viewport') {
        await act(async () => {
          test.harness.streams[1].emitFrame(frame(4))
          test.decodes[1].gate.release()
          await settle()
        })
        expect(test.setFrameMetadata.mock.calls[0][0].timestamp).toBe(4)
      }
      test.harness.lifecycle.dispose()
      test.clearFrame()
    }
  )
})
