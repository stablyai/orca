import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pasteDraftToAgentPtyWhenReady } from './agent-paste-draft'
import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'
import { finalReplayFrame } from '../../../main/runtime/agent-transcript-replay-test-harness'

const f = vi.hoisted(() => ({
  screen: ['❯ '],
  process: 'claude',
  observe: (_data: string): void => {},
  write: vi.fn(async () => true),
  notice: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: {} }))
vi.mock('@/components/terminal-pane/pty-buffer-serializer', () => ({
  readPtyInputScreen: async () => ({ lines: f.screen, alternateScreen: false })
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (_id: string, observe: (data: string) => void) => {
    f.observe = observe
    return () => {}
  }
}))
vi.mock('@/components/terminal-pane/pty-pre-handler-buffer', () => ({
  replayPreHandlerPtyData: () => {}
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: async () => ({
    foregroundProcess: f.process,
    hasChildProcesses: false
  })
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: f.write
}))
vi.mock('./launch-agent-paste-timeout-notice', () => ({ showGeneratedInputNotice: f.notice }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  f.screen = ['❯ ']
  f.process = 'claude'
  f.write.mockReset().mockResolvedValue(true)
  f.notice.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const DIALOG = [
  'Bypass Permissions',
  '❯ 1. No, exit',
  '  2. Yes, I accept',
  'Enter to confirm · Esc to cancel'
]
const args = {
  ptyId: 'pty-1',
  agent: 'claude',
  content: 'exact\nprompt',
  forcePaste: true,
  submit: true,
  timeoutMs: 3000
} as const

it('holds generated input through a startup dialog and keeps the full prompt at deadline', async () => {
  f.screen = DIALOG
  const result = pasteDraftToAgentPtyWhenReady(args)
  f.observe('\x1b[?2004h')
  await vi.advanceTimersByTimeAsync(3000)
  await expect(result).resolves.toBe(false)
  expect(f.write).not.toHaveBeenCalled()
  expect(f.notice).toHaveBeenCalledExactlyOnceWith({ agent: 'claude', text: args.content })
})

it('waits for the user to answer a dialog, then submits the prompt once', async () => {
  f.screen = DIALOG
  const result = pasteDraftToAgentPtyWhenReady(args)
  await vi.advanceTimersByTimeAsync(1600)
  expect(f.write).not.toHaveBeenCalled()
  f.screen = ['❯ ']
  f.observe('\x1b[?2004h\x1b[?2031h❯\u00a0')
  await vi.advanceTimersByTimeAsync(100)
  await expect(result).resolves.toBe(true)
  expect(f.write.mock.calls).toEqual([
    ['pty-1', '\x1b[200~exact\rprompt\x1b[201~', 'launch'],
    ['pty-1', '\r', 'launch']
  ])
})

it('never answers a dialog that appears between paste and Enter and reports uncertainty', async () => {
  f.write.mockImplementationOnce(async () => {
    f.screen = DIALOG
    return true
  })
  const result = pasteDraftToAgentPtyWhenReady(args)
  await vi.advanceTimersByTimeAsync(1800)
  await expect(result).resolves.toBe(false)
  expect(f.write).toHaveBeenCalledOnce()
  expect(f.notice).toHaveBeenCalledExactlyOnceWith({
    agent: 'claude',
    text: args.content,
    certainty: 'unconfirmed'
  })
})

it('does not type after a caller deadline expires between readiness and writing', async () => {
  const result = pasteDraftToAgentPtyWhenReady({
    ...args,
    beforePaste: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600))
      return true
    }
  })
  await vi.advanceTimersByTimeAsync(3500)
  await expect(result).resolves.toBe(false)
  expect(f.write).not.toHaveBeenCalled()
  expect(f.notice).toHaveBeenCalledWith(
    expect.objectContaining({ text: args.content, certainty: 'not-sent' })
  )
})

it('delivers a late follow-up on recorded default-quiet output without startup bytes', async () => {
  vi.useRealTimers()
  const { ruledScreenLines } = await finalReplayFrame('cline-3-0-66-ready', 120, 40)
  vi.useFakeTimers()
  f.screen = [...ruledScreenLines]
  f.process = 'cline'
  const result = sendFollowupPromptWhenAgentReady({
    ptyId: 'pty-1',
    agent: 'cline',
    expectedProcess: 'cline',
    prompt: args.content
  })
  await vi.advanceTimersByTimeAsync(1499)
  expect(f.write).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(251)
  await expect(result).resolves.toBe(true)
  expect(f.write.mock.calls).toEqual([
    ['pty-1', '\x1b[200~exact\rprompt\x1b[201~', 'launch'],
    ['pty-1', '\r', 'launch']
  ])
  expect(f.notice).not.toHaveBeenCalled()
})
