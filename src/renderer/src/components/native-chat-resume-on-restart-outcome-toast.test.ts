import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest
} from './native-chat-resume-on-restart-dialog'
import {
  _resetNativeChatRestartOffer,
  continueNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const offered: ResumeCandidate[] = ['a', 'b'].map((sessionId) => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1_800_000_000_000
}))

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  vi.mocked(toast).mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(console.warn).mockRestore()
  _resetNativeChatRestartOffer()
})

/** The host lists both chats, then loses every later call. */
function hostLostAfterListing(): void {
  let reachable = true
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable' && reachable) {
      return { sessions: offered, failed: [] }
    }
    reachable = false
    throw new Error('host unreachable')
  })
}

/** How each caller starts a resume: a click names its chats; an opted-in launch names none and
 *  reports the ones it offered. */
const resumes = {
  click: () => continueNativeChatRestartOffer(['a', 'b']),
  launch: () => continueNativeChatRestartOffer(undefined, ['a', 'b'])
}

// With the host unreachable there is no list to narrow by: every chat the resume reported failed,
// and nothing is listed for Show to open.
it.each(['click', 'launch'] as const)(
  'counts every chat of a lost %s resume when the host cannot be read either',
  async (caller) => {
    hostLostAfterListing()
    await refreshNativeChatRestartOffer()
    await resumes[caller]()
    expect(vi.mocked(toast).mock.calls).toEqual([['2 chats couldn’t be resumed', {}]])
  }
)

// The re-read lists the chats the lost request reported as failed, so the one toast keeps Show.
it('answers an opted-in launch that loses its resume request with one toast and Show', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered, failed: [] }
    }
    throw new Error('response lost')
  })
  await refreshNativeChatRestartOffer()
  await resumes.launch()
  expect(getNativeChatRestartOffer().failed.map((entry) => entry.sessionId)).toEqual(['a', 'b'])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    '2 chats couldn’t be resumed'
  ])
  expect(lastToastShow()).toBeDefined()
})

// The same toast and copy as a click: the chats it resumed ride along under the one it could not.
it('answers a mixed opted-in launch with one toast', async () => {
  const failed = [{ ...offered[1]!, failedAt: 1, outcome: 'refused', reason: 'unknown' }]
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered, failed: [] }
      : {
          continued: [
            { sessionId: 'a', outcome: 'continued' },
            { sessionId: 'b', outcome: 'refused' }
          ],
          sessions: [],
          failed
        }
  )
  await refreshNativeChatRestartOffer()
  await resumes.launch()
  expect(vi.mocked(toast).mock.calls).toEqual([
    ['1 chat couldn’t be resumed', expect.objectContaining({ description: 'Resumed 1 chat' })]
  ])
  expect(lastToastShow()).toBeDefined()
})

// Between the listing and the request every chat moved on by itself: nothing happened to report.
it('raises no toast when the host had nothing left for an opted-in launch to resume', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered, failed: [] }
      : { continued: [], sessions: [], failed: [] }
  )
  await refreshNativeChatRestartOffer()
  await resumes.launch()
  expect(toast).not.toHaveBeenCalled()
})

// The agent was seen carrying on while the toast was up, so the host retired the failure: Show
// re-reads and opens nothing, rather than latching a request for a dialog with no rows to draw.
it('opens nothing from Show once the host no longer lists the chat', async () => {
  let failed = [{ ...offered[0]!, failedAt: 1, outcome: 'unconfirmed', reason: 'unknown' }]
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: [], failed }
      : { continued: [{ sessionId: 'a', outcome: 'unknown' }], sessions: [], failed }
  )
  await refreshNativeChatRestartOffer()
  await continueNativeChatRestartOffer(['a'])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    'Couldn’t confirm 1 chat was resumed'
  ])
  failed = []
  lastToastShow()?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rpc.mock.calls.at(-1)?.[1]).toBe('agentSession.restartResumable')
  expect(getNativeChatRestartOffer().failed).toEqual([])
  expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
})
