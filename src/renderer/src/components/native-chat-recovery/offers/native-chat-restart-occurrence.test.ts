import { beforeEach, expect, it, vi } from 'vitest'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import type { RestartContinuationBatchResult } from '../runs/native-chat-restart-continuation-chunks'
import type * as HostOffer from './native-chat-restart-host-offer'
import type * as Chunks from '../runs/native-chat-restart-continuation-chunks'

const sent: string[][] = []
let reply: (result: RestartContinuationBatchResult) => void = () => {}

vi.mock('../runs/native-chat-restart-continuation-chunks', async (actual) => ({
  ...(await actual<typeof Chunks>()),
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
const dismissed: (readonly string[] | undefined)[] = []
let dismissReply: () => void = () => {}
vi.mock('./native-chat-restart-host-offer', async (actual) => ({
  ...(await actual<typeof HostOffer>()),
  readRestartHostOffer: async () => ({ candidates: offered, failed: [], available: true }),
  dismissRestartHostOffer: (_target: unknown, ids?: readonly string[]) => {
    dismissed.push(ids)
    return new Promise((resolve) => {
      dismissReply = () => resolve({ candidates: [], failed: [], listedAt: 1 })
    })
  }
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
  dismissed.length = 0
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

it('lets neither a dismissal nor a resume start while the other is in flight', async () => {
  const store = await occurrence()
  const resume = store.continueNativeChatRestartOffer(['failed'])
  void store.dismissNativeChatRestartOffer(['b'])
  expect(dismissed).toEqual([])
  reply({
    attempted: ['failed'],
    continued: [{ sessionId: 'failed', outcome: 'continued' }],
    skipped: new Set()
  })
  await resume
  expect(store.getNativeChatRestartRun()?.continued).toEqual([
    { sessionId: 'failed', outcome: 'continued' }
  ])

  const dismissal = store.dismissNativeChatRestartOffer(['b'])
  void store.continueNativeChatRestartOffer(['a'])
  expect(sent).toEqual([['failed']])
  dismissReply()
  await dismissal
  store.dispose()
})

it("follows the host's own launch action once the action in flight settles", async () => {
  const store = await occurrence()
  const dismissal = store.dismissNativeChatRestartOffer(['b'])
  const launch = store.continueNativeChatRestartOffer(['a'], 'launch', [chat('a')])
  await Promise.resolve()
  expect(sent).toEqual([])
  dismissReply()
  await dismissal
  await vi.waitFor(() => expect(sent).toEqual([['a']]))
  reply({
    attempted: ['a'],
    continued: [{ sessionId: 'a', outcome: 'continued' }],
    skipped: new Set()
  })
  await launch
  expect(store.getNativeChatRestartRun()?.continued).toEqual([
    { sessionId: 'a', outcome: 'continued' }
  ])
  store.dispose()
})

it("keeps a user resume's results when the host's launch action follows it", async () => {
  const store = await occurrence()
  const resume = store.continueNativeChatRestartOffer(['b'])
  const launch = store.continueNativeChatRestartOffer(['a'], 'launch', [chat('a')])
  expect(sent).toEqual([['b']])
  reply({
    attempted: ['b'],
    continued: [{ sessionId: 'b', outcome: 'continued' }],
    skipped: new Set()
  })
  await resume
  await vi.waitFor(() => expect(sent).toEqual([['b'], ['a']]))
  reply({
    attempted: ['a'],
    continued: [{ sessionId: 'a', outcome: 'continued' }],
    skipped: new Set()
  })
  await launch
  const run = store.getNativeChatRestartRun()
  expect(run?.entries.map((entry) => entry.candidate.sessionId)).toEqual(['b', 'a'])
  expect(run?.continued?.map((entry) => entry.outcome)).toEqual(['continued', 'continued'])
  store.dispose()
})

it('follows a waiting launch action even when another action takes the turn first', async () => {
  const store = await occurrence()
  const first = store.dismissNativeChatRestartOffer(['b'])
  const launch = store.continueNativeChatRestartOffer(['a'], 'launch', [chat('a')])
  let second: Promise<void> = Promise.resolve()
  const handoff = first.then(() => {
    second = store.dismissNativeChatRestartOffer(['c'])
  })
  dismissReply()
  await handoff
  expect(dismissed).toEqual([['b'], ['c']])
  expect(sent).toEqual([])
  dismissReply()
  await second
  await vi.waitFor(() => expect(sent).toEqual([['a']]))
  reply({
    attempted: ['a'],
    continued: [{ sessionId: 'a', outcome: 'continued' }],
    skipped: new Set()
  })
  await launch
  expect(store.getNativeChatRestartRun()?.continued).toEqual([
    { sessionId: 'a', outcome: 'continued' }
  ])
  store.dispose()
})

it('lets a waiting launch action return when the occurrence is disposed', async () => {
  const store = await occurrence()
  void store.dismissNativeChatRestartOffer(['b'])
  const launch = store.continueNativeChatRestartOffer(['a'], 'launch', [chat('a')])
  store.dispose()
  await launch
  expect(sent).toEqual([])
})
