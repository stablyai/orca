// oxlint-disable-next-line typescript/triple-slash-reference -- Main-handler integration needs the host's global declarations; the ambient file has no module export.
/// <reference path="../../../types/build-constants.d.ts" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as NoticeSubscriptions from './generated-agent-input-notices'
import { GeneratedAgentInputNotices } from '../../../main/runtime/generated-agent-input-notices'
import { GENERATED_INPUT_NOTICE_REGISTER_METHODS } from '../../../main/runtime/rpc/methods/terminal/generated-input-notice-register'
import type { RpcContext } from '../../../main/runtime/rpc/core'
import { GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY } from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import {
  generatedInputNoticeFrames,
  type GeneratedAgentInputNotice,
  type GeneratedInputNoticesPage
} from '../../../shared/generated-agent-input-notice'

/** The runtime's notice owner as its page method answers: small notices, one page. */
class FakeNoticeHost {
  readonly session: string = 'session-1'
  revision = 0
  withheld: string[] = []
  private readonly notices = new Map<string, GeneratedAgentInputNotice>()

  add(notice: Omit<GeneratedAgentInputNotice, 'id'>, id = `n${this.revision + 1}`): void {
    this.revision += 1
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
      next: null,
      ...(this.withheld.length ? { withheld: this.withheld } : {})
    }
  }
}

type NoticeState = {
  host: FakeNoticeHost | null
  // A paired host this window also reads notices from.
  remote: FakeNoticeHost | null
  holdPages: boolean
  pageReads: (() => void)[]
  shown: string[]
  dismissed: string[]
  onDismiss: Map<string, () => void>
  calls: { target: unknown; method: string; params: unknown }[]
  remoteDeliver?: (result: unknown) => void
  localDeliver?: (result: unknown) => void
  rendered: GeneratedAgentInputNotice[]
  localPage?: () => GeneratedInputNoticesPage
  callLocal?: (params: unknown) => Promise<unknown>
  completedPages: string[]
  remoteSubscription?: unknown
  pageRequests: { target: { kind: string }; options: unknown }[]
}
const state = vi.hoisted((): NoticeState => ({
  host: null,
  remote: null,
  holdPages: false,
  pageReads: [],
  shown: [],
  dismissed: [],
  onDismiss: new Map(),
  calls: [],
  rendered: [],
  completedPages: [],
  pageRequests: []
}))

vi.mock('sonner', () => ({
  toast: { dismiss: (id: string) => state.dismissed.push(id), batch: (run: () => unknown) => run() }
}))
vi.mock('@/lib/generated-input-notice-toast', () => ({
  showGeneratedInputNotice: (notice: GeneratedAgentInputNotice & { onDismiss: () => void }) => {
    state.shown.push(notice.id)
    state.rendered.push(notice)
    state.onDismiss.set(notice.id, notice.onDismiss)
  }
}))
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => true,
  ensureRuntimeEnvironmentCompatible: async () => ({ runtimeId: 'runtime-h1' }),
  callRuntimeRpc: async (
    target: { kind: string },
    method: string,
    params: unknown,
    options?: unknown
  ) => {
    if (method !== 'terminal.generatedInputNotices.page') {
      state.calls.push({ target, method, params })
      if (target.kind === 'local' && method === 'terminal.generatedInputNotices.register') {
        return state.callLocal?.(params) ?? {}
      }
      return {}
    }
    state.pageRequests.push({ target, options })
    if (state.holdPages) {
      await new Promise<void>((resolve) => state.pageReads.push(resolve))
    }
    state.completedPages.push(target.kind)
    return target.kind === 'local' && state.localPage
      ? state.localPage()
      : (target.kind === 'local' ? state.host : state.remote)!.page()
  }
}))
vi.mock('./runtime-environment-pairing-refresh', () => ({
  subscribeRuntimeEnvironment: async (
    request: unknown,
    handlers: { onResponse: (response: { ok: true; result: unknown }) => void }
  ) => {
    state.remoteSubscription = request
    state.remoteDeliver = (result) => handlers.onResponse({ ok: true, result })
    handlers.onResponse({
      ok: true,
      result: { type: 'ready', session: state.remote!.session, revision: state.remote!.revision }
    })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('./runtime-environment-revision', () => ({ getRuntimeEnvironmentRevision: () => 0 }))

let subscribeEnvironmentGeneratedInputNotices: typeof NoticeSubscriptions.subscribeEnvironmentGeneratedInputNotices
let subscribeLocalGeneratedInputNotices: typeof NoticeSubscriptions.subscribeLocalGeneratedInputNotices

function connect(): () => void {
  vi.stubGlobal('window', {
    api: {
      runtime: {
        subscribe: (
          _request: unknown,
          onResponse: (response: { ok: true; result: unknown }) => void
        ) => {
          state.localDeliver = (result) => onResponse({ ok: true, result })
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

beforeEach(async () => {
  vi.resetModules()
  ;({ subscribeEnvironmentGeneratedInputNotices, subscribeLocalGeneratedInputNotices } =
    await import('./generated-agent-input-notices'))
  state.host = new FakeNoticeHost()
  state.remote = null
  state.holdPages = false
  state.pageReads = []
  state.shown = []
  state.dismissed = []
  state.onDismiss.clear()
  state.calls = []
  state.rendered = []
  state.remoteDeliver = undefined
  state.localDeliver = undefined
  state.localPage = undefined
  state.callLocal = undefined
  state.completedPages = []
  state.pageRequests = []
  state.remoteSubscription = undefined
  vi.stubGlobal('sessionStorage', { getItem: () => 'logical-window', setItem: () => {} })
})

it('waits for local withheld state before a faster host can publish its discarded copy', async () => {
  const notice = {
    agent: 'claude' as const,
    text: 'discarded',
    handle: '',
    worktreeId: '',
    ptyId: null,
    certainty: 'unconfirmed' as const
  }
  state.host!.withheld = ['offline-discard']
  state.remote = Object.assign(new FakeNoticeHost(), { session: 'host-session' })
  state.remote.add(notice, 'offline-discard')
  state.holdPages = true
  const stopHost = subscribeEnvironmentGeneratedInputNotices('env-host')
  const stopLocal = connect()
  await vi.waitFor(() => expect(state.pageReads).toHaveLength(1))
  expect(state.remoteDeliver).toBeUndefined()
  expect(state.shown).toEqual([])
  state.holdPages = false
  state.pageReads.splice(0).forEach((release) => release())
  await vi.waitFor(() => expect(state.remoteDeliver).toBeTypeOf('function'))
  await vi.waitFor(() => expect(state.completedPages).toEqual(['local', 'environment']))
  expect(state.shown).toEqual([])
  stopHost()
  stopLocal()
})

it('retires the matching local projection before phone Dismiss, including after another reload', async () => {
  const notices = new GeneratedAgentInputNotices()
  const fields = {
    id: 'lost-reply',
    agent: 'claude' as const,
    text: 'exact text',
    handle: '',
    worktreeId: '',
    ptyId: null,
    certainty: 'unconfirmed' as const
  }
  notices.upsert({
    ...fields,
    origin: 'window-a',
    pending: true,
    connection: 'old',
    owner: {
      environmentId: 'env-host',
      runtimeId: 'runtime-h1',
      pairingRevision: 0,
      window: 'logical-window'
    }
  })
  notices.revealPending('window-a', 'new')
  state.host = Object.assign(new FakeNoticeHost(), {
    session: notices.session,
    revision: notices.revision
  })
  state.localPage = () => notices.page(0, 0, 'window-a')
  const method = GENERATED_INPUT_NOTICE_REGISTER_METHODS[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: register consumes only this notice owner, local viewer/capability and runtime id.
  const context = {
    noticeOrigin: 'window-a',
    connectionId: 'new',
    clientCapabilities: [GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY],
    runtime: { generatedInputNotices: notices, getRuntimeId: () => 'local-runtime' }
  } as unknown as RpcContext
  state.callLocal = (params) => method.handler(method.params.parse(params), context)
  const stopLocal = connect()
  const unsubscribe = notices.subscribe((change) => {
    if (change.kind === 'dismissed') {
      state.localDeliver?.({
        type: 'dismissed',
        session: notices.session,
        revision: change.revision,
        id: change.id
      })
    }
  })
  await vi.waitFor(() => expect(state.shown).toHaveLength(1))
  state.remote = Object.assign(new FakeNoticeHost(), { session: 'host-session' })
  const stopHost = subscribeEnvironmentGeneratedInputNotices('env-host')
  await vi.waitFor(() => expect(state.remoteDeliver).toBeTypeOf('function'))
  const hostNotice = { ...fields, certainty: 'not-sent' as const, handle: 'terminal-h1' }
  state.remote.add(hostNotice, fields.id)
  for (const frame of generatedInputNoticeFrames(hostNotice).frames) {
    state.remoteDeliver!({ type: 'notice', session: state.remote.session, revision: 1, frame })
  }
  await vi.waitFor(() => expect(notices.page(0, 0, 'window-a').frames).toEqual([]))
  expect(state.shown).toEqual(['generated-input:lost-reply', 'generated-input:lost-reply'])
  expect(state.dismissed).toEqual([])
  state.remote.dismiss(fields.id)
  state.remoteDeliver!({
    type: 'dismissed',
    session: state.remote.session,
    revision: 2,
    id: fields.id
  })
  expect(state.dismissed).toEqual(['generated-input:lost-reply'])
  stopHost()
  stopLocal()
  unsubscribe()

  vi.resetModules()
  state.remoteDeliver = undefined
  const beforeReload = state.completedPages.length
  ;({ subscribeEnvironmentGeneratedInputNotices, subscribeLocalGeneratedInputNotices } =
    await import('./generated-agent-input-notices'))
  const stopReloadLocal = connect()
  const stopReloadHost = subscribeEnvironmentGeneratedInputNotices('env-host')
  await vi.waitFor(() => expect(state.completedPages).toHaveLength(beforeReload + 2))
  // No retained local text remains to recreate the toast on the next complete snapshot.
  expect(notices.page(0, 0, 'window-a').frames).toEqual([])
  expect(state.shown).toHaveLength(2)
  stopReloadLocal()
  stopReloadHost()
})

it('updates same-text toast metadata once and leaves another notice untouched', async () => {
  const first = {
    agent: 'claude' as const,
    text: 'exact text',
    handle: 'before',
    worktreeId: 'workspace',
    ptyId: null,
    certainty: 'not-sent' as const
  }
  state.host!.add(first, 'changed')
  state.host!.add(first, 'unchanged')
  const stop = connect()
  await vi.waitFor(() => expect(state.rendered).toHaveLength(2))
  const updated = {
    ...first,
    id: 'changed',
    certainty: 'unconfirmed' as const,
    handle: 'after',
    ptyId: 'resolved'
  }
  const [frame] = generatedInputNoticeFrames(updated).frames
  state.localDeliver!({ type: 'notice', session: state.host!.session, revision: 3, frame })
  expect(state.rendered).toHaveLength(3)
  expect(state.rendered[2]).toMatchObject({ ...updated, id: 'generated-input:changed' })
  state.localDeliver!({ type: 'notice', session: state.host!.session, revision: 3, frame })
  expect(state.rendered).toHaveLength(3)
  expect(state.shown.filter((id) => id === 'generated-input:unchanged')).toHaveLength(1)
  stop()
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
  await vi.waitFor(() => expect(state.shown).toHaveLength(2))

  // The replacement starts before the old one stops; its snapshot is still in flight.
  state.holdPages = true
  const stopSecond = connect()
  stopFirst()
  await vi.waitFor(() => expect(state.pageReads).toHaveLength(1))
  expect(state.dismissed).toEqual([])

  const [first] = state.host!.page().frames
  state.host!.dismiss(first.id)
  state.holdPages = false
  state.pageReads.splice(0).forEach((release) => release())
  await vi.waitFor(() => expect(state.dismissed).toHaveLength(1))
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
    await vi.waitFor(() => expect(state.shown).toHaveLength(population))
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
    expect(state.dismissed.slice(dismissedBefore)).toEqual([`generated-input:live`])
    stop()
  }
)

// L3/R6-3: this window's runtime holds a copy of a request its paired host also keeps. The window
// shows one notice for the operation, the host's copy refining it, and its one Dismiss goes
// through its own runtime, which owes the host the discard.
it('shows one toast per operation across runtimes and dismisses it through this window’s runtime', async () => {
  const notice = {
    agent: 'claude' as const,
    text: 'exact',
    handle: '',
    worktreeId: '',
    ptyId: null,
    certainty: 'unconfirmed' as const
  }
  state.host = Object.assign(new FakeNoticeHost(), { session: 'local-session' })
  state.remote = Object.assign(new FakeNoticeHost(), { session: 'host-session' })
  state.host.add(notice, 'op-both')
  // Discarded before a reload; the host has not applied it yet.
  state.host.withheld = ['op-discarded']
  state.remote.add({ ...notice, certainty: 'not-sent' }, 'op-both')
  state.remote.add(notice, 'op-discarded')
  const stopLocal = connect()
  await vi.waitFor(() => expect(state.shown).toEqual(['generated-input:op-both']))
  const stopHost = subscribeEnvironmentGeneratedInputNotices('env-host')
  await vi.waitFor(() => expect(state.shown).toHaveLength(2))
  // The host's copy updates the same toast in place; the withheld one never appears.
  expect(state.shown).toEqual(['generated-input:op-both', 'generated-input:op-both'])
  expect(state.dismissed).not.toContain('generated-input:op-both')
  expect(state.remoteSubscription).toMatchObject({
    expectedEnvironmentRuntimeId: 'runtime-h1',
    expectedEnvironmentPairingRevision: 0
  })
  expect(
    state.pageRequests.find((request) => request.target.kind === 'environment')?.options
  ).toMatchObject({
    expectedEnvironmentRuntimeId: 'runtime-h1',
    expectedEnvironmentPairingRevision: 0
  })

  state.onDismiss.get('generated-input:op-both')!()
  expect(
    state.calls.filter((call) => call.method === 'terminal.dismissGeneratedInputNotice')
  ).toEqual([
    {
      target: { kind: 'local' },
      method: 'terminal.dismissGeneratedInputNotice',
      params: {
        id: 'op-both',
        owner: {
          environmentId: 'env-host',
          window: expect.any(String),
          runtimeId: 'runtime-h1',
          pairingRevision: 0
        }
      }
    }
  ])
  stopLocal()
  stopHost()
})

it.each([100, 1_000])(
  'shows %i host-only notices in web without observing nonexistent local copies',
  async (n) => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    state.remote = Object.assign(new FakeNoticeHost(), { session: 'web-host' })
    for (let index = 0; index < n; index += 1) {
      state.remote.add({
        agent: 'claude',
        text: 'host text',
        handle: 'h',
        worktreeId: 'w',
        ptyId: null,
        certainty: 'not-sent'
      })
    }
    const stop = subscribeEnvironmentGeneratedInputNotices('web-host')
    await vi.waitFor(() => expect(state.shown).toHaveLength(n))
    expect(state.calls).toEqual([])
    stop()
  }
)

it('recovers a failed local snapshot after a pending wake without exposing withheld host notices', async () => {
  state.host!.withheld = ['discarded']
  state.remote = Object.assign(new FakeNoticeHost(), { session: 'remote' })
  state.remote.add(
    {
      agent: 'claude',
      text: 'must stay hidden',
      handle: 'h',
      worktreeId: 'w',
      ptyId: null,
      certainty: 'not-sent'
    },
    'discarded'
  )
  let reads = 0
  state.localPage = () => {
    if (++reads === 1) {
      throw new Error('temporary local failure')
    }
    return state.host!.page()
  }
  state.holdPages = true
  const stopHost = subscribeEnvironmentGeneratedInputNotices('env-host')
  const stopLocal = connect()
  await vi.waitFor(() => expect(state.pageReads).toHaveLength(1))
  const { retryLocalGeneratedInputNoticeRecovery } = await import('./generated-agent-input-notices')
  retryLocalGeneratedInputNoticeRecovery()
  expect(reads).toBe(0)
  state.holdPages = false
  state.pageReads.splice(0).forEach((resolve) => resolve())
  await vi.waitFor(() => expect(state.completedPages).toEqual(['local', 'local', 'environment']))
  expect(reads).toBe(2)
  expect(state.shown).toEqual([])
  stopLocal()
  stopHost()
})

it('retries a rejected local subscription on a real recovery wake', async () => {
  let reject!: (error: Error) => void
  const subscribe = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    .mockImplementationOnce((_request, receive) => {
      receive({ ok: true, result: { type: 'ready', session: state.host!.session, revision: 0 } })
      return { unsubscribe: vi.fn() }
    })
  vi.stubGlobal('window', { api: { runtime: { subscribe } } })
  state.remote = new FakeNoticeHost()
  const stopLocal = subscribeLocalGeneratedInputNotices()
  const stopHost = subscribeEnvironmentGeneratedInputNotices('env-host')
  await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
  const { retryLocalGeneratedInputNoticeRecovery } = await import('./generated-agent-input-notices')
  retryLocalGeneratedInputNoticeRecovery()
  reject(new Error('temporary subscribe failure'))
  await vi.waitFor(() => expect(state.completedPages).toEqual(['local', 'environment']))
  expect(subscribe).toHaveBeenCalledTimes(2)
  stopHost()
  stopLocal()
})

it('observes actual overlap when local arrives after host, once per matching source session', async () => {
  vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
  state.remote = new FakeNoticeHost()
  const notice = {
    id: 'overlap',
    agent: 'claude' as const,
    text: 'same',
    handle: 'h',
    worktreeId: 'w',
    ptyId: null,
    certainty: 'not-sent' as const
  }
  state.remote.add(notice, notice.id)
  const stop = subscribeEnvironmentGeneratedInputNotices('env-host')
  await vi.waitFor(() => expect(state.shown).toHaveLength(1))
  expect(state.calls).toEqual([])
  const { projectGeneratedInputNotices } = await import('./generated-input-notice-toast-projection')
  const local = projectGeneratedInputNotices({ kind: 'local' })
  local.onSnapshot([notice], 'local', [])
  local.onDelta({ kind: 'added', notice: { ...notice, certainty: 'unconfirmed' } }, 'local')
  expect(
    state.calls.filter((call) => call.method === 'terminal.generatedInputNotices.register')
  ).toHaveLength(1)
  stop()
})

it('joins a fallback and its late canonical record, and keeps a pre-ACK Dismiss discarded', async () => {
  const { projectFallbackGeneratedInputNotice, projectGeneratedInputNotices } =
    await import('./generated-input-notice-toast-projection')
  const args = { operationId: 'slow-ack', text: 'exact', agent: 'claude' as const }
  projectFallbackGeneratedInputNotice(args)
  expect(state.shown).toEqual(['generated-input:slow-ack'])
  state.onDismiss.get('generated-input:slow-ack')!()
  const local = projectGeneratedInputNotices({ kind: 'local' })
  local.onSnapshot(
    [
      {
        id: args.operationId,
        text: args.text,
        agent: args.agent,
        certainty: 'not-sent',
        handle: '',
        worktreeId: '',
        ptyId: null
      }
    ],
    'local',
    []
  )
  expect(state.shown).toEqual(['generated-input:slow-ack'])
  expect(
    state.calls.filter((call) => call.method === 'terminal.dismissGeneratedInputNotice')
  ).toHaveLength(1)
})
