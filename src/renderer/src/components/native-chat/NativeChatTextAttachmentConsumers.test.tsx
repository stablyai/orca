// @vitest-environment happy-dom
import { useRef, useMemo } from 'react'

import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import {
  NativeChatTextAttachmentScope,
  NativeChatTextAttachments
} from './NativeChatTextAttachments'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  rpc: vi.fn(),
  write: vi.fn(),
  resolved: false,
  start: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))
vi.mock('./use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
const scope = 'agent-session:consumer35636'
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
let paste: (text: string) => boolean
function Composer({ initialValue = '' }: { initialValue?: string }) {
  const ref = useRef<NativeChatComposerInput>(null)
  paste = useNativeChatPastedTextFile({
    scopeKey: scope,
    scopeEditor: () => ref.current,
    resolveAttachmentOwner: () => ({ kind: 'local' }),
    insertTypedText: (text) => insertNativeChatPastedText(ref.current, text),
    setNotice: () => {}
  })
  const resolved = mocks.resolved
  const owner = useMemo(
    () => ({
      runtimeContext: resolved
        ? { target: { kind: 'local' as const }, worktreeId: 'w', worktreePath: '/repo' }
        : null,
      isVisible: true,
      fileLinkContext: null
    }),
    [resolved]
  )
  return (
    <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
      <NativeChatTextAttachmentScope enabled>
        <NativeChatPromptEditor
          scopeKey={scope}
          inputRef={ref}
          initialValue={initialValue}
          disabled={false}
          placeholder="Message"
          onChange={() => {}}
          onSelect={() => {}}
        />
      </NativeChatTextAttachmentScope>
    </NativeChatMarkdownImageOwnerContext.Provider>
  )
}
async function openSource() {
  fireEvent.click(await screen.findByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
}
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  nativeChatPastedTextOperations.clear()
  vi.clearAllMocks()
})

it('opens draft and sent sources, exports exact bytes and scrolls a giant-line paste to the end', async () => {
  const text = `\ufeff${Array.from({ length: 5000 }, (_, index) => `🙂paste${index}\r\n`).join('')}END35636`
  const ending = Promise.withResolvers<void>()
  let heldRange = false
  let viewportHeight = 600
  let viewportWidth = 390
  let horizontalOccupation = 0
  let rowHeight = 20
  const nativeRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('invisible')
      ? new DOMRect(0, 0, 8, rowHeight)
      : nativeRect.call(this)
  })
  const positions = new WeakMap<HTMLElement, number>()
  const horizontal = new WeakMap<HTMLElement, number>()
  const scrollWrites: HTMLElement[] = []
  let deliverScroll = true
  const later = Promise.withResolvers<void>()
  const laterStarted = Promise.withResolvers<void>()
  let holdGiant = false
  const arrayBuffer = Blob.prototype.arrayBuffer
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function (this: Blob) {
    if (holdGiant) {
      laterStarted.resolve()
      await later.promise
    }
    return arrayBuffer.call(this)
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('scrollbar-editor')
      ? Number.parseFloat(this.style.width) || viewportWidth
      : viewportWidth
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const track = this.lastElementChild
    return Math.max(
      this.clientWidth,
      track instanceof HTMLElement ? Number.parseFloat(track.style.minWidth) || 0 : 0,
      ...(track instanceof HTMLElement && track.style.overflow === 'clip'
        ? []
        : Array.from(this.querySelectorAll<HTMLElement>('[data-text-segment]')).map(
            (row) => Array.from(row.textContent || '').length * 8
          ))
    )
  })
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const left = Math.min(horizontal.get(this) || 0, this.scrollWidth - this.clientWidth)
    horizontal.set(this, left)
    return left
  })
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'set').mockImplementation(function (
    this: HTMLElement,
    value
  ) {
    horizontal.set(this, Math.max(0, Math.min(value, this.scrollWidth - this.clientWidth)))
  })
  const measurements = new Set<() => void>()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('scrollbar-editor')
      ? this.offsetHeight - (this.scrollWidth > this.clientWidth ? horizontalOccupation : 0)
      : viewportHeight
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Number.parseFloat(this.style.height) || viewportHeight
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const track = this.lastElementChild
    return Math.max(
      this.clientHeight,
      track instanceof HTMLElement ? Number.parseFloat(track.style.height) || 0 : 0,
      ...(track instanceof HTMLElement && track.style.overflow === 'clip'
        ? []
        : Array.from(this.querySelectorAll<HTMLElement>('[data-text-segment]')).map(
            (row) => Number.parseFloat(row.style.top) + Number.parseFloat(row.style.height)
          ))
    )
  })
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const top = Math.min(positions.get(this) || 0, this.scrollHeight - this.clientHeight)
    positions.set(this, top)
    return top
  })
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: HTMLElement,
    value
  ) {
    scrollWrites.push(this)
    const top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
    if (top !== this.scrollTop) {
      positions.set(this, top)
      if (deliverScroll) {
        queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
      }
    }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly notify: () => void
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this)
        measurements.add(this.notify)
      }
      observe() {}
      unobserve() {}
      disconnect() {
        measurements.delete(this.notify)
      }
    }
  )
  try {
    mocks.start.mockResolvedValue({ canceled: false, transferId: 'output' })
    mocks.finish.mockResolvedValue({ canceled: false })
    mocks.resolved = false
    const upload = Promise.withResolvers<string>()
    mocks.save.mockReturnValue(upload.promise)
    mocks.rpc.mockImplementation(async (_target, method, request) => {
      if (method === 'status.get') {
        return { capabilities: ['native-chat.text-attachment-read.v1'] }
      }
      const bytes = Buffer.from(text)
      if (request.offset > 0) {
        heldRange = true
        await ending.promise
      }
      const chunk = bytes.subarray(request.offset, request.offset + request.length)
      return {
        snapshot: 'a'.repeat(64),
        size: bytes.length,
        bytesRead: chunk.length,
        contentBase64: chunk.toString('base64'),
        eof: request.offset + chunk.length === bytes.length
      }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: { savePastedTextAsFile: mocks.save, writeClipboardText: mocks.write },
        fs: {
          startDownloadedFile: mocks.start,
          appendDownloadedFileChunk: mocks.append,
          finishDownloadedFile: mocks.finish,
          cancelDownloadedFile: mocks.cancel
        }
      }
    })
    let view = render(<Composer />)
    await act(async () => {
      expect(paste(text)).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'Pasted text' })).toBeTruthy()
    await openSource()
    fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(text))
    expect(mocks.rpc).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    mocks.resolved = true
    await act(async () => upload.resolve(path))
    view.rerender(<Composer />)
    expect(nativeChatPastedTextOperations.size).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        expect.anything(),
        'agentSessionAttachment.readTextChunk',
        expect.objectContaining({ path }),
        expect.anything()
      )
    )
    const measured = document.querySelector('.scrollbar-editor')
    if (!(measured instanceof HTMLElement)) {
      throw new Error('Expected real committed text scroller')
    }
    await waitFor(() =>
      expect(measured.querySelectorAll('[data-text-segment]').length).toBeGreaterThan(0)
    )
    fireEvent.keyDown(measured, { key: 'End' })
    await waitFor(() => expect(heldRange).toBe(true))
    await act(async () => ending.resolve())
    await waitFor(() => {
      expect(measured.textContent).toContain('END35636')
      expect(measured.scrollTop + measured.clientHeight).toBe(measured.scrollHeight)
    })
    const oldEnd = measured.scrollTop
    viewportHeight = 3000
    expect.soft(measured.scrollTop).toBe(oldEnd)
    act(() => measurements.forEach((notify) => notify()))
    await waitFor(() =>
      expect(measured.scrollTop + measured.clientHeight).toBe(measured.scrollHeight)
    )
    fireEvent.keyDown(measured, { key: 'Home' })
    await waitFor(() => {
      expect(measured.scrollTop).toBe(0)
      expect(measured.querySelector('[data-text-segment]')?.textContent).toContain('🙂paste0')
    })
    fireEvent.keyDown(measured, { key: 'PageDown' })
    await waitFor(() => {
      expect(measured.querySelector('[data-text-segment]')?.textContent).toBeTruthy()
      expect(measured.querySelector('[data-text-segment]')?.textContent).not.toContain('🙂paste0')
    })
    const visible = measured.querySelector('[data-text-segment]')?.textContent
    viewportHeight = 400
    rowHeight = 24
    act(() => measurements.forEach((notify) => notify()))
    await waitFor(() =>
      expect(measured.querySelector('[data-text-segment]')?.textContent).toBe(visible)
    )
    fireEvent.keyDown(measured, { key: 'Home' })
    await waitFor(() => expect(measured.scrollTop).toBe(0))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    const editor = promptEditor(screen.getByRole('textbox'))
    const token = promptValue(screen.getByRole('textbox')).trim()
    act(() => {
      editor.commands.selectAll()
      editor.commands.deleteSelection()
    })
    expect(screen.queryByRole('button', { name: 'Pasted text' })).toBeNull()
    await act(async () => {
      editor.commands.undo()
    })
    expect(screen.getByRole('button', { name: 'Pasted text' })).toBeTruthy()
    const saved = structuredClone(readNativeChatComposerDraft(scope))
    expect(saved.text).toContain(token)
    const sent = resolveNativeChatPastedText(scope, token)
    expect(sent).toBe(`@${path}`)
    view.unmount()
    clearNativeChatComposerDraftsForTests()
    updateNativeChatComposerDraft(
      scope,
      { text: saved.text, document: saved.document, pastedTextFiles: saved.pastedTextFiles },
      'immediate'
    )
    expect(readNativeChatComposerDraft(scope).text).toBe(saved.text)
    view = render(
      <NativeChatTextAttachments
        content={sent}
        structured
        runtimeContext={{ target: { kind: 'local' }, worktreeId: 'w', worktreePath: '/repo' }}
        renderText={(content) => <span>{content}</span>}
      />
    )
    await openSource()
    fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2))
    expect(mocks.write.mock.calls[1]).toEqual([text])
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save file' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(mocks.finish).toHaveBeenCalledOnce())
    expect(
      Buffer.concat(
        mocks.append.mock.calls.map(([args]) => Buffer.from(args.contentBase64, 'base64'))
      ).equals(Buffer.from(text))
    ).toBe(true)
    view.unmount()
    const giant = `${'x'.repeat(25 * 1024 * 1024)}TAIL`
    mocks.resolved = false
    const heldUpload = Promise.withResolvers<string>()
    mocks.save.mockReturnValueOnce(heldUpload.promise)
    viewportHeight = 600
    view = render(<Composer />)
    await act(async () => {
      expect(paste(giant)).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
        true
      )
    )
    const scroller = document.querySelector('.scrollbar-editor')
    if (!(scroller instanceof HTMLElement)) {
      throw new Error('Expected real text scroller')
    }
    await waitFor(() =>
      expect(scroller.querySelectorAll('[data-text-segment]').length).toBeGreaterThan(0)
    )
    const track = scroller.lastElementChild
    if (!(track instanceof HTMLElement)) {
      throw new Error('Expected virtual track')
    }
    expect(Number.parseFloat(track.style.height)).toBeLessThan(8_000_000)
    scroller.scrollLeft = 500
    holdGiant = true
    await act(async () => {
      scroller.scrollTop = 4000
    })
    await laterStarted.promise
    expect.soft(scroller.scrollLeft).toBe(500)
    deliverScroll = false
    scroller.scrollTop += 80
    const liveTop = scroller.scrollTop
    const writes = scrollWrites.filter((node) => node === scroller).length
    holdGiant = false
    await act(async () => later.resolve())
    await waitFor(() =>
      expect(scroller.querySelectorAll('[data-text-segment]').length).toBeGreaterThan(0)
    )
    expect.soft(scrollWrites.filter((node) => node === scroller).length).toBe(writes)
    expect.soft(scroller.scrollTop).toBe(liveTop)
    expect.soft(scroller.scrollLeft).toBe(500)
    deliverScroll = true
    fireEvent.scroll(scroller)

    fireEvent.scroll(scroller, {
      target: { scrollTop: Number.parseFloat(track.style.height) - 600 }
    })
    await waitFor(() => expect(scroller.textContent).toContain('TAIL'))
    expect(scroller.querySelectorAll('[data-text-segment]').length).toBeLessThanOrEqual(
      Math.ceil(viewportHeight / rowHeight) + 4
    )
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } })
    await waitFor(() =>
      expect(scroller.querySelector('[data-text-segment]')?.textContent).toBe('x'.repeat(256))
    )
    viewportHeight = 3000
    rowHeight = 10
    act(() => measurements.forEach((measure) => measure()))
    await waitFor(() => {
      const rows = scroller.querySelectorAll('[data-text-segment]')
      expect(rows.length).toBeGreaterThanOrEqual(Math.ceil(viewportHeight / rowHeight))
      expect(rows.length).toBeLessThanOrEqual(Math.ceil(viewportHeight / rowHeight) + 4)
      expect(scroller.scrollTop).toBe(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => heldUpload.resolve(path))
    view.unmount()
    viewportHeight = 600
    viewportWidth = 400
    rowHeight = 20
    horizontalOccupation = 6
    const dense = `HEAD${'X'.repeat(56)}\n${'\n'.repeat(50 * 1024 * 1024 - 61)}`
    mocks.save.mockReturnValueOnce(new Promise(() => {}))
    view = render(<Composer />)
    await act(async () => {
      expect(paste(dense)).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
    const classic = document.querySelector('.scrollbar-editor')
    if (!(classic instanceof HTMLElement)) {
      throw new Error('Expected native classic-scrollbar host')
    }
    await waitFor(() =>
      expect(classic.querySelector('[data-text-segment]')?.textContent).toContain('HEAD')
    )
    act(() => measurements.forEach((notify) => notify()))
    // Visit real source blocks through the shipping wheel/demand/read path, without a prefilled index.
    for (let block = 1; block < 100; block++) {
      await act(async () => {
        fireEvent.wheel(classic, { deltaY: (block === 1 ? 15348 : 15352) * rowHeight })
      })
    }
    fireEvent.keyDown(classic, { key: 'End' })
    await waitFor(() => expect(classic.scrollHeight).toBe(8_000_593))
    await waitFor(() => expect(classic.scrollTop).toBe(7_999_999))
    const classicEnd = classic.scrollTop
    viewportWidth = 650
    expect.soft(classic.scrollTop).toBe(classicEnd)
    act(() => measurements.forEach((notify) => notify()))
    await waitFor(() => expect(classic.scrollTop + classic.clientHeight).toBe(classic.scrollHeight))
    view.unmount()
  } finally {
    ending.resolve()
    later.resolve()
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
