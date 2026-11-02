import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  generatedInputNoticeFrames,
  type GeneratedAgentInputNotice,
  type GeneratedInputNoticesPage
} from '../../../shared/generated-agent-input-notice'

/** The runtime's notice owner as its page method answers: small notices, one page. */
class FakeNoticeHost {
  readonly session = 'session-1'
  revision = 0
  private readonly notices = new Map<string, GeneratedAgentInputNotice>()

  add(notice: Omit<GeneratedAgentInputNotice, 'id'>): void {
    this.revision += 1
    const id = `n${this.revision}`
    this.notices.set(id, { ...notice, id })
  }

  dismiss(id: string): void {
    this.revision += 1
    this.notices.delete(id)
  }

  page(): GeneratedInputNoticesPage {
    return {
      session: this.session,
      revision: this.revision,
      frames: [...this.notices.values()].flatMap(
        (notice) => generatedInputNoticeFrames(notice).frames
      ),
      next: null
    }
  }
}

type NoticeState = {
  host: FakeNoticeHost | null
  holdPages: boolean
  pageReads: (() => void)[]
  shown: string[]
  dismissed: string[]
}
const state = vi.hoisted((): NoticeState => ({
  host: null,
  holdPages: false,
  pageReads: [],
  shown: [],
  dismissed: []
}))

vi.mock('sonner', () => ({ toast: { dismiss: (id: string) => state.dismissed.push(id) } }))
vi.mock('@/lib/launch-agent-paste-timeout-notice', () => ({
  showGeneratedInputNotice: (notice: { id: string }) => state.shown.push(notice.id)
}))
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => true,
  callRuntimeRpc: async (_target: unknown, method: string) => {
    if (method !== 'terminal.generatedInputNotices.page') {
      return {}
    }
    if (state.holdPages) {
      await new Promise<void>((resolve) => state.pageReads.push(resolve))
    }
    return state.host!.page()
  }
}))
vi.mock('./runtime-environment-pairing-refresh', () => ({ subscribeRuntimeEnvironment: vi.fn() }))
vi.mock('./runtime-environment-revision', () => ({ getRuntimeEnvironmentRevision: () => 0 }))

const { subscribeLocalGeneratedInputNotices } = await import('./generated-agent-input-notices')

const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function connect(): () => void {
  vi.stubGlobal('window', {
    api: {
      runtime: {
        subscribe: (
          _request: unknown,
          onResponse: (response: { ok: true; result: unknown }) => void
        ) => {
          onResponse({
            ok: true,
            result: { type: 'ready', session: state.host!.session, revision: state.host!.revision }
          })
          return { unsubscribe: () => {} }
        }
      }
    }
  })
  return subscribeLocalGeneratedInputNotices()
}

beforeEach(() => {
  state.host = new FakeNoticeHost()
  state.holdPages = false
  state.pageReads = []
  state.shown = []
  state.dismissed = []
})

afterEach(() => vi.unstubAllGlobals())

it('keeps the same toasts when a subscription is replaced, reconciling only after its snapshot', async () => {
  const add = (text: string) =>
    state.host!.add({
      agent: 'claude',
      text,
      handle: 'h',
      worktreeId: 'w',
      ptyId: null,
      certainty: 'not-sent'
    })
  add('first')
  add('second')
  const stopFirst = connect()
  await settle()
  expect(state.shown).toHaveLength(2)

  // The replacement starts before the old one stops; its snapshot is still in flight.
  state.holdPages = true
  const stopSecond = connect()
  stopFirst()
  await settle()
  expect(state.dismissed).toEqual([])

  const [first] = state.host!.page().frames
  state.host!.dismiss(first.id)
  state.holdPages = false
  state.pageReads.splice(0).forEach((release) => release())
  await settle()
  // Only the notice the host dismissed goes; the survivor is neither dismissed nor shown twice.
  expect(state.shown).toHaveLength(2)
  expect(state.dismissed).toEqual([state.shown[0]])
  stopSecond()
})

// K7: the snapshot shows each retained notice once; after it a live add or dismissal costs one
// toast call, whatever the population (no rescan of the shown notices on our side).
it.each([1_000, 10_000])(
  'shows %i retained notices once, then applies one live add and dismissal with one call each',
  async (population) => {
    // Its own runtime session, so toasts other cases left in this environment are not reused.
    state.host = Object.assign(new FakeNoticeHost(), { session: `session-${population}` })
    for (let i = 0; i < population; i += 1) {
      state.host!.add({
        agent: 'claude',
        text: `t${i}`,
        handle: 'h',
        worktreeId: 'w',
        ptyId: null,
        certainty: 'not-sent'
      })
    }
    let deliver!: (result: unknown) => void
    vi.stubGlobal('window', {
      api: {
        runtime: {
          subscribe: (
            _request: unknown,
            onResponse: (response: { ok: true; result: unknown }) => void
          ) => {
            deliver = (result) => onResponse({ ok: true, result })
            deliver({ type: 'ready', session: state.host!.session, revision: state.host!.revision })
            return { unsubscribe: () => {} }
          }
        }
      }
    })
    const stop = subscribeLocalGeneratedInputNotices()
    await settle()
    expect(state.shown).toHaveLength(population)
    const shownBefore = state.shown.length
    const dismissedBefore = state.dismissed.length
    const [frame] = generatedInputNoticeFrames({
      id: 'live',
      agent: 'claude',
      text: 'x',
      handle: 'h',
      worktreeId: 'w',
      ptyId: null,
      certainty: 'not-sent'
    }).frames
    const session = state.host!.session
    deliver({ type: 'notice', session, revision: state.host!.revision + 1, frame })
    deliver({ type: 'dismissed', session, revision: state.host!.revision + 2, id: 'live' })
    expect(state.shown).toHaveLength(shownBefore + 1)
    expect(state.dismissed.slice(dismissedBefore)).toEqual([
      `generated-input:local:${session}:live`
    ])
    stop()
  }
)
