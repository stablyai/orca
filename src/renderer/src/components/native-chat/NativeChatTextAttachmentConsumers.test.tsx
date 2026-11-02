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
  const text = `\ufeff${'🙂paste\r\n'.repeat(5000)}`
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
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
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
  fireEvent.scroll(scroller, { target: { scrollTop: Number.parseFloat(track.style.height) - 600 } })
  await waitFor(() => expect(scroller.textContent).toContain('TAIL'))
  expect(scroller.querySelectorAll('[data-text-segment]').length).toBeLessThanOrEqual(256)
  fireEvent.scroll(scroller, { target: { scrollTop: 0 } })
  await waitFor(() =>
    expect(scroller.querySelector('[data-text-segment]')?.textContent).toBe('x'.repeat(256))
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await act(async () => heldUpload.resolve(path))
  view.unmount()
  height.mockRestore()
  offsetHeight.mockRestore()
})
