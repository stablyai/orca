import { beforeEach, expect, it, vi } from 'vitest'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import type { RestartContinuationBatchResult } from '../runs/native-chat-restart-continuation-chunks'
import type * as HostOffer from './native-chat-restart-host-offer'

const sent: string[][] = []
let reply: (result: RestartContinuationBatchResult) => void = () => {}

vi.mock('../runs/native-chat-restart-continuation-chunks', () => ({
  continueRestartChunks: (_target: unknown, ids: readonly string[]) => {
    sent.push([...ids])
    return new Promise<RestartContinuationBatchResult>((resolve) => {
      reply = resolve
    })
  }
}))
vi.mock('../runs/native-chat-resume-run-status-watch', () => ({
  watchResumeRunStatus: () => () => {}
}))
vi.mock('./native-chat-restart-host-offer', async (actual) => ({
  ...(await actual<typeof HostOffer>()),
  readRestartHostOffer: async () => ({ candidates: offered, failed: [], available: true })
}))
vi.mock('./native-chat-remote-restart-offer', () => ({
  createRemoteRestartOfferLifecycle: () => ({ dispose: () => {}, observeRuntimeStatus: () => {} }),
  readDesktopCreatedChatIds: async () => new Set<string>()
}))
vi.mock('./native-chat-resume-offered-chat-watch', () => ({
  createOfferedChatWatch: () => ({ sync: () => {}, release: () => {} })
}))
vi.mock('@/runtime/native-chat/status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => undefined
}))
vi.mock('./native-chat-launch-resume-decision', () => ({
  markNativeChatLaunchResumeDecided: () => {}
}))

const chat = (sessionId: string): ResumeCandidate => ({
  sessionId,
  workspaceId: 'example-workspace',
  agent: 'claude',
  trigger: 'update',
  latestPrompt: 'Example prompt',
  recordedAt: 1
})
let offered: ResumeCandidate[] = []

async function occurrence() {
  const { createNativeChatRestartOccurrence } = await import('./native-chat-restart-occurrence')
  const store = createNativeChatRestartOccurrence({ kind: 'local' }, 'local', new Set())
  await store.readNativeChatRestartOffer()
  return store
}

beforeEach(() => {
  sent.length = 0
  offered = [chat('a'), chat('b'), chat('failed')]
})

it('sends once when Retry is activated again before the first action settles', async () => {
  const store = await occurrence()
  void store.continueNativeChatRestartOffer(['failed'])
  void store.continueNativeChatRestartOffer(['failed'])
  void store.continueNativeChatRestartOffer(['b'])

  expect(sent).toEqual([['failed']])
  store.dispose()
})

it('reports earlier successes after a retry settles', async () => {
  const store = await occurrence()
  const first = store.continueNativeChatRestartOffer(['a', 'b', 'failed'])
  reply({
    attempted: ['a', 'b', 'failed'],
    continued: [
      { sessionId: 'a', outcome: 'continued' },
      { sessionId: 'b', outcome: 'continued' },
      { sessionId: 'failed', outcome: 'refused' }
    ],
    skipped: new Set()
  })
  await first

  offered = [chat('failed')]
  const retry = store.continueNativeChatRestartOffer(['failed'])
  reply({
    attempted: ['failed'],
    continued: [{ sessionId: 'failed', outcome: 'continued' }],
    skipped: new Set()
  })
  await retry

  const run = store.getNativeChatRestartRun()
  expect(sent).toEqual([['a', 'b', 'failed'], ['failed']])
  expect(run?.entries.map((entry) => entry.candidate.sessionId)).toEqual(['a', 'b', 'failed'])
  expect(run?.continued?.map((entry) => entry.outcome)).toEqual([
    'continued',
    'continued',
    'continued'
  ])
  store.dispose()
})
