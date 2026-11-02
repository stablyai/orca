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

const state = vi.hoisted(() => ({
  host: null as FakeNoticeHost | null,
  holdPages: false,
  pageReads: [] as (() => void)[],
  shown: [] as string[],
  dismissed: [] as string[]
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
