// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness } from './remote-browser-stream-lifecycle-test-harness'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(async (..._args: unknown[]) => ({}))
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

import {
  useRemoteBrowserPageInput,
  useRemoteBrowserPageInputQueue
} from './use-remote-browser-page-input'

const log: string[] = []
const runRemoteNavigation = vi.fn(async (method: string) => {
  log.push(method)
})

function Frame(): React.JSX.Element {
  const { lifecycle } = createHarness()
  lifecycle.tokens.setRemotePage('page-1')
  const { enqueueRemoteInput } = useRemoteBrowserPageInputQueue()
  const viewport = document.createElement('div')
  // Why: happy-dom lays nothing out; left clicks need a non-empty rect to map to a page point.
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100)
  const {
    handleRemotePointerDown,
    handleRemotePointerUp,
    handleRemoteSideButtonMove,
    handleRemoteLostPointerCapture
  } = useRemoteBrowserPageInput({
    busy: false,
    imageRef: { current: document.createElement('img') },
    remoteViewportRef: { current: viewport },
    remoteCssViewportSizeRef: { current: { width: 100, height: 100 } },
    remoteViewportSizeRef: { current: { width: 100, height: 100 } },
    frameMetadata: null,
    runtimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' }),
    lifecycle,
    runtimeWorktree: 'worktree-a',
    enqueueRemoteInput,
    createRemoteOperationToken: (remotePageId) =>
      lifecycle.tokens.createOperationToken(remotePageId),
    isCurrentRemoteOperationToken: () => true,
    closeMissingRemotePage: vi.fn(),
    scheduleRemoteTabInfoRefresh: vi.fn(),
    setPaneNotice: vi.fn(),
    runRemoteNavigation
  })
  return (
    <img
      alt=""
      data-testid="frame"
      onPointerDown={handleRemotePointerDown}
      onPointerUp={handleRemotePointerUp}
      onPointerMove={handleRemoteSideButtonMove}
      onLostPointerCapture={handleRemoteLostPointerCapture}
    />
  )
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('remote browser frame mouse Back/Forward', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    log.length = 0
  })

  it('goes back in the remote page on Back release without sending mouse input', async () => {
    render(<Frame />)
    const frame = screen.getByTestId('frame')

    expect(fireEvent.pointerDown(frame, { button: 3 })).toBe(false)
    expect(fireEvent.pointerUp(frame, { button: 3 })).toBe(false)
    await settle()

    expect(runRemoteNavigation).toHaveBeenCalledExactlyOnceWith('browser.back')
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('goes forward in the remote page on Forward release', async () => {
    render(<Frame />)
    const frame = screen.getByTestId('frame')

    fireEvent.pointerDown(frame, { button: 4 })
    fireEvent.pointerUp(frame, { button: 4 })
    await settle()

    expect(runRemoteNavigation).toHaveBeenCalledExactlyOnceWith('browser.forward')
  })

  it('goes back for a side button chorded with the primary button', async () => {
    render(<Frame />)
    const frame = screen.getByTestId('frame')

    expect(fireEvent.pointerMove(frame, { button: 3, buttons: 1 | 8 })).toBe(false)
    expect(fireEvent.pointerMove(frame, { button: 3, buttons: 1 })).toBe(false)
    await settle()

    expect(runRemoteNavigation).toHaveBeenCalledExactlyOnceWith('browser.back')
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('captures the pointer so a release over Orca chrome still reaches the page', () => {
    render(<Frame />)
    const frame = screen.getByTestId('frame')
    const setPointerCapture = vi.fn()
    frame.setPointerCapture = setPointerCapture

    fireEvent.pointerDown(frame, { button: 3, pointerId: 7 })

    expect(setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('captures the pointer for a side button chorded with the primary button', () => {
    render(<Frame />)
    const frame = screen.getByTestId('frame')
    const setPointerCapture = vi.fn()
    frame.setPointerCapture = setPointerCapture

    fireEvent.pointerMove(frame, { button: 4, buttons: 1 | 16, pointerId: 7 })

    expect(setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('ignores a release whose press began over Orca chrome', async () => {
    render(<Frame />)

    fireEvent.pointerUp(screen.getByTestId('frame'), { button: 3 })
    await settle()

    expect(runRemoteNavigation).not.toHaveBeenCalled()
  })

  it('drops a press whose capture was lost before release', async () => {
    render(<Frame />)
    const frame = screen.getByTestId('frame')

    fireEvent.pointerDown(frame, { button: 3 })
    fireEvent.lostPointerCapture(frame)
    fireEvent.pointerUp(frame, { button: 3 })
    await settle()

    expect(runRemoteNavigation).not.toHaveBeenCalled()
  })

  it('waits for a click still in flight before going back', async () => {
    let releaseMouseUp = (): void => {}
    mocks.callRuntimeRpc.mockImplementation(async (_target, method) => {
      if (method === 'browser.mouseUp') {
        await new Promise<void>((resolve) => {
          releaseMouseUp = resolve
        })
      }
      log.push(String(method))
      return {}
    })
    render(<Frame />)
    const frame = screen.getByTestId('frame')

    fireEvent.pointerDown(frame, { button: 0 })
    fireEvent.pointerUp(frame, { button: 0 })
    fireEvent.pointerDown(frame, { button: 3 })
    fireEvent.pointerUp(frame, { button: 3 })
    await settle()
    expect(runRemoteNavigation).not.toHaveBeenCalled()

    releaseMouseUp()
    await settle()

    expect(log.at(-2)).toBe('browser.mouseUp')
    expect(log.at(-1)).toBe('browser.back')
  })
})
