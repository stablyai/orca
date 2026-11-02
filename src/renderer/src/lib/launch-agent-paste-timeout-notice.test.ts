import type { MouseEvent } from 'react'
import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { showGeneratedInputNotice } from './launch-agent-paste-timeout-notice'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: () => 'claude' }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: { agent: string }) =>
    fallback.replace('{{agent}}', args?.agent ?? '')
}))

it('keeps exact prompt text available after Copy until explicit dismissal', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const dismiss = vi.fn()
  showGeneratedInputNotice({ agent: 'claude', text: 'exact\ntext', onDismiss: dismiss })
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
  // SAFETY: this action only consumes preventDefault; no DOM event fields are accessed.
  options.action.onClick(event as unknown as MouseEvent<HTMLButtonElement>)
  await Promise.resolve()
  expect(writeText).toHaveBeenCalledExactlyOnceWith('exact\ntext')
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
