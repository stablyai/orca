// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, useRef, useState, type RefObject } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  cleanup()
})

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

function renderProxyTextarea(): HTMLTextAreaElement {
  const { lifecycle } = createHarness()
  lifecycle.tokens.setRemotePage('page')
  const queued: Promise<void>[] = []
  const proxyRef: RefObject<HTMLTextAreaElement | null> = { current: null }
  function StreamedPage() {
    const { handleRemoteKeyboardProxyText } = useRemoteBrowserPageKeyboard({
      pickerAvailable: false,
      runtimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' }),
      lifecycle,
      runtimeWorktree: 'wt',
      keyboardProxyRef: proxyRef,
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
    return createElement('textarea', {
      'data-testid': 'proxy',
      ref: (node: HTMLTextAreaElement | null) => {
        proxyRef.current = node
      },
      onInput: handleRemoteKeyboardProxyText
    })
  }
  const { getByTestId } = render(createElement(StreamedPage))
  const proxy = getByTestId('proxy')
  if (!(proxy instanceof HTMLTextAreaElement)) {
    throw new Error('The proxy fixture rendered something other than a textarea')
  }
  return proxy
}

it('presses Backspace on the page when the empty proxy cannot delete anything', async () => {
  const proxy = renderProxyTextarea()
  proxy.focus()
  const beforeInput = new InputEvent('beforeinput', {
    inputType: 'deleteContentBackward',
    bubbles: true,
    cancelable: true
  })
  fireEvent(proxy, beforeInput)

  // Already pressed on the page, so the proxy must not also apply an edit of its own.
  expect(beforeInput.defaultPrevented).toBe(true)
  await vi.waitFor(() =>
    expect(calls).toEqual([
      { method: 'browser.keypress', params: { worktree: 'wt', page: 'page', key: 'Backspace' } }
    ])
  )
})

it('presses Enter instead of forwarding the newline a one-line page form cannot submit', async () => {
  const proxy = renderProxyTextarea()
  proxy.focus()
  fireEvent(
    proxy,
    new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })
  )

  await vi.waitFor(() =>
    expect(calls).toEqual([
      { method: 'browser.keypress', params: { worktree: 'wt', page: 'page', key: 'Enter' } }
    ])
  )
})

it('forwards text the proxy already holds rather than pressing a key for it', async () => {
  const proxy = renderProxyTextarea()
  proxy.value = 'abc'
  fireEvent(
    proxy,
    new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true
    })
  )
  expect(calls).toEqual([])
})

it('presses Backspace on the page when the proxy mounts after the pane first rendered', async () => {
  const { lifecycle } = createHarness()
  lifecycle.tokens.setRemotePage('page')
  let showProxy = () => {}
  function StreamedPage() {
    const keyboardProxyRef = useRef<HTMLTextAreaElement | null>(null)
    const [keyboardProxyNode, setKeyboardProxyNode] = useState<HTMLTextAreaElement | null>(null)
    const [mounted, setMounted] = useState(false)
    showProxy = () => setMounted(true)
    const { handleRemoteKeyboardProxyText } = useRemoteBrowserPageKeyboard({
      pickerAvailable: false,
      runtimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' }),
      lifecycle,
      runtimeWorktree: 'wt',
      keyboardProxyRef,
      keyboardProxyNode,
      enqueueRemoteInput: (operation) => operation(),
      createRemoteOperationToken: (pageId) => lifecycle.tokens.createOperationToken(pageId),
      isCurrentRemoteOperationToken: (token) => lifecycle.tokens.isCurrent(token),
      closeMissingRemotePage: vi.fn(),
      scheduleRemoteTabInfoRefresh: vi.fn(),
      setPaneNotice: vi.fn(),
      closeSelectPopupForPageInput: vi.fn(),
      readSelectPopupAfterKey: vi.fn()
    })
    return mounted
      ? createElement('textarea', {
          'data-testid': 'proxy',
          ref: (node: HTMLTextAreaElement | null) => {
            keyboardProxyRef.current = node
            setKeyboardProxyNode(node)
          },
          onInput: handleRemoteKeyboardProxyText
        })
      : createElement('img', { alt: 'Waiting for the first stream frame' })
  }

  const { getByTestId, getByRole } = render(createElement(StreamedPage))
  expect(getByRole('img')).toBeTruthy()

  act(() => showProxy())
  const proxy = getByTestId('proxy')
  proxy.focus()
  const beforeInput = new InputEvent('beforeinput', {
    inputType: 'deleteContentBackward',
    bubbles: true,
    cancelable: true
  })
  fireEvent(proxy, beforeInput)

  expect(beforeInput.defaultPrevented).toBe(true)
  await vi.waitFor(() =>
    expect(calls).toEqual([
      { method: 'browser.keypress', params: { worktree: 'wt', page: 'page', key: 'Backspace' } }
    ])
  )
})
