// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES
} from '../../../../shared/attachment-text-source'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
const path = '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/report.txt'
const target = { kind: 'environment', environmentId: 'env-text' } as const
beforeEach(async () => {
  await i18n.changeLanguage('en')
  replaceRuntimeEnvironmentRevisions([{ id: 'env-text', createdAt: 1 }])
  mocks.write.mockReset().mockResolvedValue(undefined)
  mocks.start.mockReset().mockResolvedValue({ canceled: false, transferId: 'output' })
  mocks.append.mockReset().mockResolvedValue(undefined)
  mocks.finish.mockReset().mockResolvedValue({ canceled: false })
  mocks.cancel.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: mocks.write },
      fs: {
        startDownloadedFile: mocks.start,
        appendDownloadedFileChunk: mocks.append,
        finishDownloadedFile: mocks.finish,
        cancelDownloadedFile: mocks.cancel
      }
    }
  })
  mocks.rpc.mockReset().mockResolvedValue({
    runtimeId: 'host-1',
    capabilities: ['native-chat.text-attachment-read.v1']
  })
})
afterEach(cleanup)
const waitUntilEnabled = (name: string) =>
  waitFor(() => expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(false))

const begin = (button: HTMLElement, input: HTMLInputElement) => {
  const pointer = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    pointerType: 'touch',
    button: 0,
    buttons: 1
  })
  act(() => {
    if (button.dispatchEvent(pointer)) {
      button.focus()
    }
  })
  expect(pointer.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(input)
  const mouse = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 0
  })
  act(() => {
    if (button.dispatchEvent(mouse)) {
      button.focus()
    }
  })
  expect(mouse.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(input)
}
const complete = (button: HTMLElement) => {
  fireEvent.pointerUp(button, { button: 0 })
  fireEvent.mouseUp(button, { button: 0 })
  fireEvent.click(button)
}

it.each([
  { action: 'Next', mode: 'held', page: '12', section: 2 },
  { action: 'First', mode: 'held', page: '1', section: 1 },
  { action: 'Last', mode: 'held', page: '12', section: 32 },
  { action: 'Previous', mode: 'held', page: '11', section: 32 },
  { action: 'Next', mode: 'cached', page: '12', section: 2 },
  { action: 'Next', mode: 'failed', page: '5', section: 2 },
  { action: 'Next', mode: 'unmounted', page: '5', section: 1 },
  { action: 'Previous', mode: 'endpoint', page: '1', section: 1 }
])(
  'joins an edited field before $action ($mode) through actual DOM focus defaults and completion',
  async ({ action, mode, page, section }) => {
    const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
    for (let page = 0; page < 12; page++) {
      content.write(
        `P${String(page + 1).padStart(2, '0')}-S1-L001 SECTIONTOP\n`,
        page * ATTACHMENT_TEXT_PAGE_BYTES
      )
    }
    const gate = Promise.withResolvers<void>()
    const originalPage = AttachmentTextSource.prototype.page
    let failurePresentations = 0
    const pageCalls = vi.spyOn(AttachmentTextSource.prototype, 'page').mockImplementation(function (
      this: AttachmentTextSource,
      page,
      subpage = 0
    ) {
      if (mode === 'failed' && page === 4 && subpage === 1) {
        expect(screen.getAllByRole('alert')).toHaveLength(1)
        failurePresentations++
      }
      return originalPage.call(this, page, subpage)
    })
    const normal = mocks.rpc.getMockImplementation()!
    const offsets: number[] = []
    let held = false
    mocks.rpc.mockImplementation(async (...args) => {
      if (args[1] === 'status.get') {
        return normal(...args)
      }
      const request = args[2]
      offsets.push(request.offset)
      if (
        held &&
        request.offset === (mode === 'endpoint' ? 0 : 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3)
      ) {
        await gate.promise
        if (mode === 'failed') {
          throw new Error('offline')
        }
      }
      const chunk = content.subarray(request.offset, request.offset + request.length)
      return {
        snapshot: 'a'.repeat(64),
        size: content.length,
        contentBase64: chunk.toString('base64'),
        bytesRead: chunk.length,
        eof: request.offset + chunk.length === content.length
      }
    })
    const view = render(
      <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
    )
    const input = () => {
      const node = screen.getByRole('spinbutton', { name: 'Attachment page' })
      if (!(node instanceof HTMLInputElement)) {
        throw new Error('Expected page input')
      }
      return node
    }
    const edit = (value: string) => fireEvent.change(input(), { target: { value } })
    const ready = () => waitUntilEnabled('Copy contents')
    const go = async (value: string) => {
      act(() => input().focus())
      edit(value)
      act(() => input().blur())
      await ready()
    }
    try {
      await ready()
      if (mode === 'cached') {
        await go('12')
      }
      if (mode === 'endpoint') {
        await go('3')
      }
      await go('5')
      const fieldPage = mode === 'endpoint' ? 0 : 11
      const owner = pageCalls.mock.contexts.at(-1)
      const beforeCalls = pageCalls.mock.calls.length
      const beforeOffsets = offsets.slice()
      act(() => input().focus())
      for (const value of mode === 'endpoint' ? ['', '1'] : ['', '1', '12']) {
        edit(value)
        expect(pageCalls).toHaveBeenCalledTimes(beforeCalls)
        expect(offsets).toEqual(beforeOffsets)
      }
      held = mode !== 'cached'
      const button = screen.getByRole('button', { name: action })
      expect(button.hasAttribute('disabled')).toBe(false)
      begin(button, input())
      expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual([])
      expect(offsets).toEqual(beforeOffsets)
      expect(button.hasAttribute('disabled')).toBe(false)
      complete(button)
      if (mode !== 'cached') {
        expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual([[fieldPage, 0]])
        await waitFor(() =>
          expect(offsets).toEqual([
            ...beforeOffsets,
            Math.max(0, fieldPage * ATTACHMENT_TEXT_PAGE_BYTES - 3)
          ])
        )
        expect(button.hasAttribute('disabled')).toBe(true)
        expect(input().value).toBe('5')
        expect(screen.getByText(/Section 1\//)).toBeTruthy()
      }
      if (mode === 'unmounted') {
        view.unmount()
        if (!(owner instanceof AttachmentTextSource)) {
          throw new Error('Expected actual attachment source owner')
        }
        expect(owner.disposed).toBe(true)
        await act(async () => {
          gate.resolve()
        })
        expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual([[fieldPage, 0]])
        expect(screen.queryByRole('spinbutton')).toBeNull()
      } else {
        await act(async () => {
          held = false
          gate.resolve()
        })
        await ready()
        const nextCall =
          action === 'First'
            ? [0, 0]
            : action === 'Last'
              ? [11, Number.MAX_SAFE_INTEGER]
              : action === 'Previous'
                ? [10, Number.MAX_SAFE_INTEGER]
                : [mode === 'failed' ? 4 : 11, 1]
        expect(pageCalls.mock.calls.slice(beforeCalls)).toEqual(
          mode === 'endpoint' ? [[0, 0]] : [[11, 0], nextCall]
        )
        expect(failurePresentations).toBe(mode === 'failed' ? 1 : 0)
        expect(input().value).toBe(page)
        expect(screen.getByText(`Section ${section}/32`)).toBeTruthy()
        if (action === 'First') {
          expect(screen.getByText('P01-S1-L001 SECTIONTOP')).toBeTruthy()
        }
        if (mode === 'cached') {
          expect(offsets).toEqual(beforeOffsets)
        }
        if (mode === 'held' && action === 'Next') {
          expect(offsets).toEqual([
            ...beforeOffsets,
            Math.max(0, fieldPage * ATTACHMENT_TEXT_PAGE_BYTES - 3)
          ])
        }
        // An untouched field does not reset a later section or add a dispatch.
        const calls = pageCalls.mock.calls.length
        act(() => input().focus())
        act(() => input().blur())
        expect(pageCalls).toHaveBeenCalledTimes(calls)
        expect(screen.getByText(`Section ${section}/32`)).toBeTruthy()
      }
      process.stdout.write(
        `PR35636 DOM join ${JSON.stringify({ action, mode, calls: pageCalls.mock.calls.slice(beforeCalls), offsets })}\n`
      )
    } finally {
      gate.resolve()
      view.unmount()
      pageCalls.mockRestore()
    }
  }
)

it('retires a canceled start before a new busy successor without storing permission', async () => {
  const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
  const gate = Promise.withResolvers<void>()
  const calls = vi.spyOn(AttachmentTextSource.prototype, 'page')
  let held = false
  const offsets: number[] = []
  const normal = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementation(async (...args) => {
    if (args[1] === 'status.get') {
      return normal(...args)
    }
    const request = args[2]
    offsets.push(request.offset)
    if (held && request.offset === 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3) {
      await gate.promise
    }
    const chunk = content.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: content.length,
      contentBase64: chunk.toString('base64'),
      bytesRead: chunk.length,
      eof: request.offset + chunk.length === content.length
    }
  })
  const view = render(
    <NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />
  )
  const input = screen.getByRole('spinbutton')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Expected actual page input')
  }
  try {
    await waitUntilEnabled('Copy contents')
    act(() => input.focus())
    fireEvent.change(input, { target: { value: '5' } })
    act(() => input.blur())
    await waitUntilEnabled('Copy contents')
    const start = calls.mock.calls.length
    const reads = offsets.slice()
    act(() => input.focus())
    fireEvent.change(input, { target: { value: '12' } })
    const next = screen.getByRole('button', { name: 'Next' })
    begin(next, input)
    fireEvent.pointerMove(next, { clientY: -100 })
    fireEvent.pointerUp(document.body, { button: 0, clientY: -100 })
    expect(document.activeElement).toBe(input)
    expect(calls.mock.calls.slice(start)).toEqual([])
    expect(offsets).toEqual(reads)
    held = true
    act(() => input.blur())
    await waitFor(() => expect(next.hasAttribute('disabled')).toBe(true))
    fireEvent.pointerDown(next, { button: 0, isPrimary: true })
    fireEvent.mouseDown(next, { button: 0, buttons: 0 })
    complete(next)
    expect(calls.mock.calls.slice(start)).toEqual([[11, 0]])
    await act(async () => {
      held = false
      gate.resolve()
    })
    await waitUntilEnabled('Copy contents')
    expect(calls.mock.calls.slice(start)).toEqual([[11, 0]])
    expect(input.value).toBe('12')
    expect(screen.getByText('Section 1/32')).toBeTruthy()
    const plain = calls.mock.calls.length
    fireEvent.click(next, { detail: 0 })
    await waitUntilEnabled('Copy contents')
    expect(calls.mock.calls.slice(plain)).toEqual([[11, 1]])
  } finally {
    gate.resolve()
    view.unmount()
    calls.mockRestore()
  }
})

it.each([
  { action: 'Copy contents', mode: 'success' },
  { action: 'Copy contents', mode: 'failed' },
  { action: 'Save file', mode: 'failed' },
  { action: 'Retry', mode: 'retired' },
  { action: 'Close', mode: 'retired' }
])('joins or retires the same field operation for $action ($mode)', async ({ action, mode }) => {
  const content = Buffer.from('a\n'.repeat(ATTACHMENT_TEXT_PAGE_BYTES * 6))
  const gate = Promise.withResolvers<void>()
  const calls = vi.spyOn(AttachmentTextSource.prototype, 'page')
  const copied = vi.spyOn(AttachmentTextSource.prototype, 'copyText')
  const normal = mocks.rpc.getMockImplementation()!
  let held = false
  let failed = false
  let fieldRequested = false
  mocks.rpc.mockImplementation(async (...args) => {
    if (args[1] === 'status.get') {
      return normal(...args)
    }
    const request = args[2]
    if (held && request.offset === 11 * ATTACHMENT_TEXT_PAGE_BYTES - 3) {
      fieldRequested = true
      await gate.promise
      if (mode === 'failed' && !failed) {
        failed = true
        throw new Error('field read failed')
      }
    }
    const chunk = content.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: content.length,
      contentBase64: chunk.toString('base64'),
      bytesRead: chunk.length,
      eof: request.offset + chunk.length === content.length
    }
  })
  const close = vi.fn()
  const view = render(
    <NativeChatTextAttachmentPreview path={path} target={target} onClose={close} />
  )
  const input = screen.getByRole('spinbutton')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Expected actual page input')
  }
  try {
    await waitUntilEnabled('Copy contents')
    if (action === 'Retry') {
      mocks.rpc.mockRejectedValueOnce(new Error('earlier error'))
      act(() => input.focus())
      fireEvent.change(input, { target: { value: '3' } })
      act(() => input.blur())
      await screen.findByText(
        'Unable to read this attachment on its host. Reconnect and try again. The file may have been removed or changed.'
      )
      await waitUntilEnabled('Copy contents')
    }
    const owner = calls.mock.contexts.at(-1)
    if (!(owner instanceof AttachmentTextSource)) {
      throw new Error('Expected actual source owner')
    }
    const start = calls.mock.calls.length
    act(() => input.focus())
    fireEvent.change(input, { target: { value: '12' } })
    held = true
    const button = screen.getByRole('button', { name: action })
    begin(button, input)
    expect(calls).toHaveBeenCalledTimes(start)
    complete(button)
    expect(calls.mock.calls.slice(start)[0]).toEqual([11, 0])
    expect(copied).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    if (mode !== 'retired') {
      await waitFor(() => expect(fieldRequested).toBe(true))
    }
    if (mode === 'retired') {
      await waitFor(() => expect(owner.disposed).toBe(true))
      if (action === 'Close') {
        expect(close).toHaveBeenCalledOnce()
      } else {
        await waitUntilEnabled('Copy contents')
        expect(calls.mock.contexts.at(-1)).not.toBe(owner)
        expect(input.value).toBe('1')
      }
    }
    await act(async () => {
      held = false
      gate.resolve()
    })
    if (action === 'Copy contents') {
      await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(content.toString('utf8')))
      expect(copied).toHaveBeenCalledOnce()
    } else if (action === 'Save file') {
      await waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce())
      expect(
        Buffer.concat(
          mocks.append.mock.calls.map(([args]) => Buffer.from(args.contentBase64, 'base64'))
        )
      ).toEqual(content)
    }
    if (mode === 'failed') {
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(
        screen.getByText(
          'Unable to read this attachment on its host. Reconnect and try again. The file may have been removed or changed.'
        )
      ).toBeTruthy()
      expect(input.value).toBe('1')
    }
    if (action === 'Retry') {
      expect(input.value).toBe('1')
    }
    if (mode === 'retired') {
      expect(mocks.write).not.toHaveBeenCalled()
      expect(mocks.finish).not.toHaveBeenCalled()
    }
  } finally {
    gate.resolve()
    view.unmount()
    calls.mockRestore()
    copied.mockRestore()
  }
})
