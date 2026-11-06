// @vitest-environment happy-dom
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { useContext, useState, useMemo } from 'react'
import { toast } from 'sonner'
import { i18n } from '@/i18n/i18n'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  NativeChatTextAttachmentScope,
  NativeChatTextAttachmentOpener
} from './NativeChatTextAttachments'
import { NativeChatTextAttachmentPreview } from './NativeChatTextAttachmentPreview'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => {
  const routing: { context: RuntimeFileOperationArgs | null; web: boolean } = {
    context: null,
    web: false
  }
  return {
    ...routing,
    rpc: vi.fn(),
    write: vi.fn(),
    start: vi.fn(),
    append: vi.fn(),
    finish: vi.fn(),
    cancel: vi.fn()
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
const target = { kind: 'environment', environmentId: 'env-text' } as const
const bytes = Buffer.from(['\ufeffstart\r\n', '🙂'.repeat(20_000), 'end'].join(''))
let capable = true

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.mocked(toast.success).mockClear()
  capable = true
  mocks.context = null
  mocks.web = false
  mocks.cancel.mockReset().mockResolvedValue(undefined)
  replaceRuntimeEnvironmentRevisions([{ id: 'env-text', createdAt: 1 }])
  mocks.rpc.mockReset().mockImplementation(async (_target, method, request) => {
    if (method === 'status.get') {
      return {
        runtimeId: 'host-1',
        capabilities: capable ? [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] : []
      }
    }
    const chunk = bytes.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      contentBase64: chunk.toString('base64'),
      bytesRead: chunk.length,
      eof: request.offset + chunk.length === bytes.length
    }
  })
  mocks.write.mockReset().mockResolvedValue(undefined)
  mocks.start.mockReset().mockResolvedValue({ canceled: false, transferId: 'output' })
  mocks.append.mockReset().mockResolvedValue(undefined)
  mocks.finish.mockReset().mockResolvedValue({ canceled: false })
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
})
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

const waitUntilEnabled = (name: string) =>
  waitFor(() => expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(false))

it('shows the old-host limitation and refreshes capability on Retry without affecting the message', async () => {
  capable = false
  render(<NativeChatTextAttachmentPreview path={path} target={target} onClose={() => {}} />)
  await screen.findByText(/This host cannot open text attachments yet/)
  expect(mocks.rpc.mock.calls.every((call) => call[1] === 'status.get')).toBe(true)
  capable = true
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitUntilEnabled('Copy contents')
})

it('keeps focused stateful composer descendants mounted when owner context changes', async () => {
  mocks.context = { target: { kind: 'local' }, worktreeId: 'w', worktreePath: '/repo' }
  function Child() {
    const [value, setValue] = useState('')
    const open = useContext(NativeChatTextAttachmentOpener)
    return (
      <>
        <input
          aria-label="draft"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button onClick={() => open?.(path)}>Open source</button>
      </>
    )
  }
  function Ui() {
    const runtimeContext = mocks.context
    const owner = useMemo(
      () => ({ runtimeContext, isVisible: true, fileLinkContext: null }),
      [runtimeContext]
    )
    return (
      <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
        <NativeChatTextAttachmentScope enabled>
          <Child />
        </NativeChatTextAttachmentScope>
      </NativeChatMarkdownImageOwnerContext.Provider>
    )
  }
  const ui = () => <Ui />
  const view = render(ui())
  const input = screen.getByRole('textbox', { name: 'draft' })
  fireEvent.change(input, { target: { value: 'local editor state' } })
  input.focus()
  mocks.context = { ...mocks.context, worktreePath: '/renamed' }
  view.rerender(ui())
  expect(screen.getByRole('textbox', { name: 'draft', hidden: true })).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('value')).toBe('local editor state')
  fireEvent.click(screen.getByRole('button', { name: 'Open source' }))
  await waitUntilEnabled('Copy contents')
  const gate = Promise.withResolvers<unknown>()
  const normal = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementationOnce(() => gate.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await act(async () => {})
  mocks.context = { ...mocks.context, expectedSshConnectionGeneration: 2 }
  view.rerender(ui())
  expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
  await act(async () =>
    gate.resolve(
      await normal(target, 'agentSessionAttachment.readTextChunk', {
        offset: 0,
        length: bytes.length
      })
    )
  )
  expect(mocks.write).not.toHaveBeenCalled()
  expect(mocks.finish).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open source' }))
  await waitUntilEnabled('Copy contents')
  expect(screen.getByRole('textbox', { name: 'draft', hidden: true })).toBe(input)
  const picker = Promise.withResolvers<{ canceled: false; transferId: string }>()
  mocks.start.mockReturnValueOnce(picker.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
  await act(async () => {})
  mocks.context = { ...mocks.context, worktreePath: '/changed-again' }
  view.rerender(ui())
  await act(async () => picker.resolve({ canceled: false, transferId: 'late-output' }))
  expect(mocks.cancel).toHaveBeenCalledWith({ transferId: 'late-output' })
  expect(mocks.append).not.toHaveBeenCalled()
  expect(mocks.finish).not.toHaveBeenCalled()
})
