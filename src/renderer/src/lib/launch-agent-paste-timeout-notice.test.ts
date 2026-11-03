import type { MouseEvent } from 'react'
import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  createPasteReadinessTimeoutNotice,
  noticeGeneratedInputFailure,
  showGeneratedInputNotice
} from './launch-agent-paste-timeout-notice'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
const registered = vi.hoisted(() => ({ calls: [] as unknown[], keeps: true }))
// This window's runtime: registration keeps the notice, or (keeps false) cannot.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: unknown) => {
    registered.calls.push({ method, params })
    if (!registered.keeps) {
      throw new Error('no runtime')
    }
    return { retained: true }
  },
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ tabsByWorktree: { w: [{ id: 't', ptyId: 'pty-1' }] } }) }
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'claude' }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: { agent: string }) =>
    fallback.replace('{{agent}}', args?.agent ?? '')
}))

// Q1: the page's clipboard write is refused in the app (NotAllowedError); Copy goes through the
// main process, as every other Copy does.
it('copies the exact multiline text through the desktop clipboard, and Copy never dismisses', async () => {
  const pageWrite = vi.fn(async () => {
    throw new DOMException('Write permission denied.', 'NotAllowedError')
  })
  vi.stubGlobal('navigator', { clipboard: { writeText: pageWrite } })
  const writeClipboardText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('window', { api: { ui: { writeClipboardText } } })
  const dismiss = vi.fn()
  showGeneratedInputNotice({ agent: 'claude', text: 'exact\r\n  text\n', onDismiss: dismiss })
  expect(toast.message).toHaveBeenCalledWith(
    expect.stringContaining('Claude'),
    expect.objectContaining({ duration: Infinity, closeButton: true, onDismiss: dismiss })
  )
  const options = vi.mocked(toast.message).mock.calls[0][1]
  if (
    !options?.action ||
    typeof options.action !== 'object' ||
    !('onClick' in options.action) ||
    typeof options.action.onClick !== 'function'
  ) {
    throw new Error('missing Copy action')
  }
  const event = { preventDefault: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this action only consumes preventDefault; no DOM event fields are accessed.
  options.action.onClick(event as unknown as MouseEvent<HTMLButtonElement>)
  await Promise.resolve()
  expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('exact\r\n  text\n')
  expect(pageWrite).not.toHaveBeenCalled()
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(dismiss).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

// An unsubmitted draft is the user's notes, as before; only a submitted request is a prompt.
it('names an unsubmitted draft as notes, in its message and its Copy action', () => {
  vi.mocked(toast.message).mockClear()
  showGeneratedInputNotice({ agent: 'codex', text: 'n', submitted: false })
  showGeneratedInputNotice({
    agent: 'codex',
    text: 'n',
    submitted: false,
    certainty: 'unconfirmed'
  })
  const calls = vi.mocked(toast.message).mock.calls
  expect(calls.map(([message]) => message)).toEqual([
    "Your notes weren't sent to Codex. Answer any dialog in its terminal, then paste your notes.",
    'Codex may have received part of your notes. Check its terminal before sending again.'
  ])
  for (const [, options] of calls) {
    expect(options?.action).toMatchObject({ label: 'Copy notes' })
  }
})

// E4 and every send-less exit: the window's runtime keeps the notice (it survives a reload and is
// shown through the notice feed); the toast is only the fallback when that runtime cannot.
it.each([true, false])(
  'keeps held keys as notes in the window runtime (runtime keeps: %s)',
  async (keeps) => {
    registered.calls = []
    registered.keeps = keeps
    vi.mocked(toast.message).mockClear()
    createPasteReadinessTimeoutNotice({
      worktreeId: 'w',
      tabId: 't',
      agent: 'claude',
      submitted: false,
      content: 'held\r\nkeys 😀'
    }).onTimeout('not-sent')
    await vi.waitFor(() => expect(registered.calls).toHaveLength(1))
    expect(registered.calls[0]).toEqual({
      method: 'terminal.generatedInputNotices.register',
      params: expect.objectContaining({
        text: 'held\r\nkeys 😀',
        agent: 'claude',
        certainty: 'not-sent',
        submitted: false
      })
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(toast.message).toHaveBeenCalledTimes(keeps ? 0 : 1)
  }
)

it('keeps an unknown agent’s notice with no agent, for the generic name', async () => {
  registered.calls = []
  registered.keeps = true
  noticeGeneratedInputFailure({ text: 'x' })
  await vi.waitFor(() => expect(registered.calls).toHaveLength(1))
  expect(registered.calls[0]).toMatchObject({ params: { agent: null, certainty: 'not-sent' } })
})
