// @vitest-environment happy-dom
import { fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { createHarness } from './remote-browser-stream-lifecycle-test-harness'

const calls = vi.hoisted((): { method: string; params: Record<string, unknown> }[] => [])

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    return { result: JSON.stringify({ inReach: true, handled: true }) }
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ keybindings: {} }) } }))

const { useRemoteBrowserPageKeyboard } = await import('./use-remote-browser-page-keyboard')

it('pastes only the plain text into a streamed page, even when the clipboard carries markup and files', async () => {
  const { lifecycle } = createHarness()
  lifecycle.tokens.setRemotePage('page')
  const queued: Promise<void>[] = []
  function StreamedPage() {
    const { handleRemoteScreenshotPaste } = useRemoteBrowserPageKeyboard({
      pickerAvailable: false,
      runtimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' }),
      lifecycle,
      runtimeWorktree: 'wt',
      enqueueRemoteInput: (operation) => {
        const run = operation()
        queued.push(run)
        return run
      },
      createRemoteOperationToken: (pageId) => lifecycle.tokens.createOperationToken(pageId),
      isCurrentRemoteOperationToken: (token) => lifecycle.tokens.isCurrent(token),
      closeMissingRemotePage: vi.fn(),
      scheduleRemoteTabInfoRefresh: vi.fn(),
      setPaneNotice: vi.fn(),
      closeSelectPopupForPageInput: vi.fn(),
      readSelectPopupAfterKey: vi.fn()
    })
    return createElement('img', { alt: 'Streamed page', onPaste: handleRemoteScreenshotPaste })
  }

  const { getByRole } = render(createElement(StreamedPage))
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', 'plain')
  clipboardData.setData('text/html', '<b>rich</b>')
  clipboardData.items.add(new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' }))
  fireEvent(
    getByRole('img'),
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
  )
  await Promise.all(queued)

  expect(calls).toEqual([
    {
      method: 'browser.keyboardInsertText',
      params: { worktree: 'wt', page: 'page', text: 'plain' }
    }
  ])
})
