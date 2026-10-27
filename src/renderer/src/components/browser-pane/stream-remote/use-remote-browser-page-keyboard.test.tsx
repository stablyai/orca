// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_TEXT_INSERT_CHUNK_BYTES } from '../../../../../shared/browser-text-insertion-chunks'
import { createHarness } from './remote-browser-stream-lifecycle-test-harness'
import { useRemoteBrowserPageInputQueue } from './use-remote-browser-page-input'
import { useRemoteBrowserPageKeyboard } from './use-remote-browser-page-keyboard'

const callRuntimeRpc = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))
vi.mock('@/hooks/useShortcutLabel', () => ({ getShortcutPlatform: () => 'linux' }))

const { lifecycle } = createHarness()
lifecycle.tokens.setRemotePage('page-a')

function StreamedFrame(): React.JSX.Element {
  const { enqueueRemoteInput } = useRemoteBrowserPageInputQueue()
  const { handleRemoteScreenshotKeyDown, handleRemoteScreenshotPaste } =
    useRemoteBrowserPageKeyboard({
      runtimeTarget: () => ({ kind: 'environment', environmentId: 'environment-a' }),
      lifecycle,
      runtimeWorktree: 'worktree-a',
      enqueueRemoteInput,
      createRemoteOperationToken: (remotePageId) => ({
        tabId: 'tab-a',
        environmentId: 'environment-a',
        remotePageId: remotePageId ?? null,
        generation: 1
      }),
      isCurrentRemoteOperationToken: () => true,
      closeMissingRemotePage: vi.fn(),
      scheduleRemoteTabInfoRefresh: vi.fn(),
      setPaneNotice: vi.fn()
    })
  return (
    <img
      alt=""
      tabIndex={0}
      data-testid="frame"
      onKeyDown={handleRemoteScreenshotKeyDown}
      onPaste={handleRemoteScreenshotPaste}
    />
  )
}

function sentInput(): unknown[][] {
  return callRuntimeRpc.mock.calls.map((call) => call.slice(1, 3))
}

afterEach(() => {
  cleanup()
  callRuntimeRpc.mockClear()
})

describe('streamed browser page keyboard input', () => {
  it('inserts the local clipboard on paste, in order with surrounding typing', async () => {
    render(<StreamedFrame />)
    const frame = screen.getByTestId('frame')

    fireEvent.keyDown(frame, { key: 'a' })
    // Default stays allowed so the browser fires the paste event with our clipboard.
    expect(fireEvent.keyDown(frame, { key: 'v', ctrlKey: true })).toBe(true)
    fireEvent.paste(frame, { clipboardData: { getData: () => 'XYZ' } })
    fireEvent.keyDown(frame, { key: 'b' })

    await waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledTimes(3))
    expect(sentInput()).toEqual([
      ['browser.keypress', { worktree: 'worktree-a', page: 'page-a', key: 'a' }],
      ['browser.keyboardInsertText', { worktree: 'worktree-a', page: 'page-a', text: 'XYZ' }],
      ['browser.keypress', { worktree: 'worktree-a', page: 'page-a', key: 'b' }]
    ])
  })

  it('splits a large paste so no request exceeds the runtime socket frame', async () => {
    render(<StreamedFrame />)
    const text = 'x'.repeat(BROWSER_TEXT_INSERT_CHUNK_BYTES + 1)

    fireEvent.paste(screen.getByTestId('frame'), { clipboardData: { getData: () => text } })

    await waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledTimes(2))
    const params = { worktree: 'worktree-a', page: 'page-a' }
    expect(sentInput()).toEqual([
      ['browser.keyboardInsertText', { ...params, text: text.slice(0, -1) }],
      ['browser.keyboardInsertText', { ...params, text: 'x' }]
    ])
  })
})
