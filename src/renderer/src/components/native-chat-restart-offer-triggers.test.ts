// @vitest-environment happy-dom

import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { RestartOfferOrigin } from '../../../shared/restart-offer-origin'
import { useAppStore } from '../store'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest,
  mountNativeChatResumeDialog,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import {
  getNativeChatRestartOffers,
  readNativeChatRestartMachine
} from './native-chat-resume-on-restart-store'
import {
  continueNativeChatRestartOffers,
  dismissNativeChatRestartOffer
} from './native-chat-restart-offer-actions'
import {
  _resetNativeChatRestartOffer,
  useNativeChatRestartOfferSources
} from './native-chat-restart-offer-triggers'
import { cleanup, renderHook } from '@testing-library/react'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { pairedEnvironment, verifiedConnection } from './native-chat-restart-offer-test-support'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  support: vi.fn(async (): Promise<'supported' | 'unsupported' | 'unknown'> => 'supported')
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.rpc,
  pairedRestartOffersSupport: mocks.support,
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const SERVER = 'studio'
const MACHINE = `environment:${SERVER}`
const TARGET = { kind: 'environment', environmentId: SERVER } as const
const RECORDED_AT = 1_800_000_000_000

function row(
  sessionId: string,
  origin: RestartOfferOrigin | undefined,
  trigger: 'quit' | 'update' = 'update',
  recordedAt = RECORDED_AT
) {
  return {
    sessionId,
    workspaceId: `workspace-${sessionId}`,
    agent: 'codex',
    trigger,
    latestPrompt: `Prompt ${sessionId}`,
    recordedAt,
    // The server's own terms: its host is `local` there.
    executionHostId: 'local',
    workspaceKind: 'git-worktree',
    ...(origin ? { origin } : {})
  } satisfies ResumeCandidate
}

function stageServer(status: { runtimeId: string; epoch?: number; pairingRevision?: number }) {
  const pairingRevision = status.pairingRevision ?? 1
  replaceRuntimeEnvironmentRevisions([{ id: SERVER, createdAt: 1, pairingRevision }])
  useAppStore.setState({
    runtimeEnvironments: [pairedEnvironment(SERVER, 'studio-mac')],
    runtimeEnvironmentCatalogHydrated: true,
    runtimeStatusByEnvironmentId: new Map([
      [
        SERVER,
        verifiedConnection({
          environmentId: SERVER,
          runtimeId: status.runtimeId,
          hostContactEpoch: status.epoch,
          pairingRevision
        })
      ]
    ])
  })
}

function callsTo(method: string): unknown[][] {
  return mocks.rpc.mock.calls.filter(([, called]) => called === method)
}

function continueCalls(): unknown[] {
  return callsTo('agentSession.restartContinue').map(([target, , params]) => [target, params])
}

function offerReads(): number {
  return callsTo('agentSession.restartResumable').length
}

function toastTitles(): string[] {
  return vi.mocked(toast).mock.calls.map(([title]) => String(title))
}

/** Sonner types a toast button as a labelled action or arbitrary content; only the former can be
 *  pressed. */
function press(entry: unknown): void {
  if (
    typeof entry !== 'object' ||
    entry === null ||
    !('onClick' in entry) ||
    typeof entry.onClick !== 'function'
  ) {
    throw new Error('toast button is not clickable')
  }
  entry.onClick()
}

function label(entry: unknown): unknown {
  return typeof entry === 'object' && entry !== null && 'label' in entry ? entry.label : undefined
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

/** A connected desktop: the watcher reads the server on its verified connection. */
async function connect(status: { runtimeId: string; epoch?: number; pairingRevision?: number }) {
  stageServer(status)
  renderHook(() => useNativeChatRestartOfferSources(false))
  await vi.waitFor(() => expect(offerReads()).toBeGreaterThan(0))
  await settle()
}

function serveOffers(sessions: ReturnType<typeof row>[]): void {
  mocks.rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions, failed: [] }
      : { continued: [], sessions: [], failed: [] }
  )
}

beforeEach(() => {
  vi.mocked(toast).mockClear()
  mocks.rpc.mockReset()
  mocks.support.mockReset()
  mocks.support.mockResolvedValue('supported')
  window.localStorage.clear()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalNativeChat: false }
  })
  serveOffers([row('a', 'own'), row('b', 'other-device')])
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it("rewrites a server's rows to its runtime host, so its workspaces are found under it", async () => {
  await connect({ runtimeId: 'r2' })
  expect(
    getNativeChatRestartOffers()
      .get(MACHINE)
      ?.candidates.map((candidate) => candidate.executionHostId)
  ).toEqual(['runtime:studio', 'runtime:studio'])
})

it("toasts the user's own interruptions once, and a reconnect without a restart adds nothing", async () => {
  await connect({ runtimeId: 'r2' })
  expect(vi.mocked(toast).mock.calls).toEqual([
    [
      'studio-mac restarted for an update',
      expect.objectContaining({
        description:
          '1 of your chats there was stopped mid-reply. It shows where it stopped, and nothing was lost.'
      })
    ]
  ])
  stageServer({ runtimeId: 'r2', epoch: 1 })
  await vi.waitFor(() => expect(offerReads()).toBe(2))
  await settle()
  expect(toast).toHaveBeenCalledTimes(1)
})

it('names a plain quit by the server being restarted', async () => {
  serveOffers([row('a', 'own', 'quit')])
  await connect({ runtimeId: 'r2' })
  expect(toastTitles()[0]).toBe('Orca on studio-mac was restarted')
})

it('raises no toast for chats that are not the user’s, nor for a row with no answer', async () => {
  serveOffers([
    row('a', 'other-device'),
    row('b', 'automation'),
    row('c', 'server-made'),
    row('d', undefined)
  ])
  await connect({ runtimeId: 'r2' })
  expect(toast).not.toHaveBeenCalled()
  expect(getNativeChatRestartOffers().get(MACHINE)?.candidates).toHaveLength(4)
})

it("the toast's buttons resume exactly the own chats there, or open the dialog on that server", async () => {
  await connect({ runtimeId: 'r2' })
  const options = vi.mocked(toast).mock.calls[0]?.[1]
  expect([label(options?.action), label(options?.cancel)]).toEqual(['Resume 1 chat', 'Show chats'])
  press(options?.cancel)
  // It re-reads the server first, then opens over what it still lists.
  await settle()
  expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: MACHINE })
  press(options?.action)
  await settle()
  expect(continueCalls()).toEqual([[TARGET, { sessionIds: ['a'] }]])
})

it('resumes only own chats without asking, once per interruption, when the preference is on', async () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), nativeChatResumeWorkOnRestart: true }
  })
  const rows = [row('a', 'own'), row('b', 'automation'), row('c', 'other-device')]
  mocks.rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: rows, failed: [] }
      : { continued: [{ sessionId: 'a', outcome: 'continued' }], sessions: [], failed: [] }
  )
  await connect({ runtimeId: 'r2' })
  stageServer({ runtimeId: 'r2', epoch: 1 })
  await vi.waitFor(() => expect(offerReads()).toBeGreaterThanOrEqual(2))
  await settle()
  expect(continueCalls()).toEqual([[TARGET, { sessionIds: ['a'] }]])
  // No reconnect offer: the resume's own one toast says what it did, as a launch's does.
  expect(toastTitles()).toEqual(['Resumed 1 chat on studio-mac'])
})

// A fresh window (a reload, or a reopened window on macOS) reads the same offer again.
it('decides nothing twice across a new window, and forgets interruptions the server no longer offers', async () => {
  await connect({ runtimeId: 'r2' })
  expect(toast).toHaveBeenCalledTimes(1)
  _resetNativeChatRestartOffer()
  await connect({ runtimeId: 'r2' })
  expect(toast).toHaveBeenCalledTimes(1)
  // Resumed elsewhere, then interrupted again: a new interruption of the same chat is announced.
  serveOffers([])
  await readNativeChatRestartMachine(TARGET)
  serveOffers([row('a', 'own', 'update', RECORDED_AT + 1)])
  await readNativeChatRestartMachine(TARGET)
  expect(toast).toHaveBeenCalledTimes(2)
})

// The watcher mounts before the saved server list loads; a server not listed yet is not removed.
it('keeps an earlier run’s decisions through boot, before the server list has loaded', async () => {
  const stored = JSON.stringify({ [SERVER]: [`a\u0000${RECORDED_AT}`] })
  window.localStorage.setItem('orca.nativeChatRestartDecided.v1', stored)
  renderHook(() => useNativeChatRestartOfferSources(false))
  expect(window.localStorage.getItem('orca.nativeChatRestartDecided.v1')).toBe(stored)
  stageServer({ runtimeId: 'r2' })
  await vi.waitFor(() => expect(offerReads()).toBeGreaterThan(0))
  await settle()
  expect(toast).not.toHaveBeenCalled()
})

// Storage that refuses writes must not turn one interruption into repeated decisions this run.
it('decides each interruption once per run even when storage refuses writes', async () => {
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError')
  })
  try {
    await connect({ runtimeId: 'r2' })
    for (const epoch of [1, 2]) {
      stageServer({ runtimeId: 'r2', epoch })
      await vi.waitFor(() => expect(offerReads()).toBe(epoch + 1))
      await settle()
    }
    expect(toast).toHaveBeenCalledTimes(1)
  } finally {
    refuse.mockRestore()
  }
})

it('continues an interruption at most once per run when storage refuses writes and the continue fails', async () => {
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), nativeChatResumeWorkOnRestart: true }
  })
  // Bounded so a regression ends: after five continues the server stops listing the chat.
  mocks.rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: continueCalls().length >= 5 ? [] : [row('a', 'own')], failed: [] }
    }
    throw new Error('timeout')
  })
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError')
  })
  try {
    await connect({ runtimeId: 'r2' })
    await vi.waitFor(() => expect(offerReads()).toBeGreaterThanOrEqual(2))
    await settle()
    expect(continueCalls()).toHaveLength(1)
  } finally {
    refuse.mockRestore()
  }
})

// A dialog on screen lists every machine: no toast repeats it.
it('raises no toast while a resume dialog is on screen, which lists the server too', async () => {
  const unmount = mountNativeChatResumeDialog()
  try {
    requestNativeChatResumeOnRestartDialog('local')
    await connect({ runtimeId: 'r2' })
    expect(toast).not.toHaveBeenCalled()
  } finally {
    unmount()
  }
})

// A request alone is not a dialog the user sees: one nothing draws must not swallow the toast.
it('still announces a paired interruption while a request is pending but no dialog is drawn', async () => {
  requestNativeChatResumeOnRestartDialog('local')
  await connect({ runtimeId: 'r2' })
  expect(toastTitles()).toEqual(['studio-mac restarted for an update'])
})

it('announces a paired interruption once no resume dialog is open', async () => {
  await connect({ runtimeId: 'r2' })
  expect(toastTitles()).toEqual(['studio-mac restarted for an update'])
})

it('opens nothing from a toast whose chats are already gone', async () => {
  await connect({ runtimeId: 'r2' })
  const options = vi.mocked(toast).mock.calls[0]?.[1]
  serveOffers([])
  await readNativeChatRestartMachine(TARGET)
  press(options?.cancel)
  await settle()
  expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
})

// Re-pairing to a server that cannot be reached yet must not leave the old pairing's rows behind.
it('forgets the old pairing’s rows as soon as the saved record is re-paired', async () => {
  await connect({ runtimeId: 'r2' })
  replaceRuntimeEnvironmentRevisions([{ id: SERVER, createdAt: 1, pairingRevision: 2 }])
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
})

it('decides what an open dialog already shows without a toast', async () => {
  const unmount = mountNativeChatResumeDialog()
  requestNativeChatResumeOnRestartDialog(null)
  await connect({ runtimeId: 'r2' })
  expect(toast).not.toHaveBeenCalled()
  unmount()
  consumeNativeChatResumeOnRestartDialogRequest()
  await readNativeChatRestartMachine(TARGET)
  expect(toast).not.toHaveBeenCalled()
})

it('never asks a server that does not advertise paired restart offers', async () => {
  mocks.support.mockResolvedValue('unsupported')
  stageServer({ runtimeId: 'r2' })
  renderHook(() => useNativeChatRestartOfferSources(false))
  await vi.waitFor(() => expect(mocks.support).toHaveBeenCalled())
  await settle()
  expect(offerReads()).toBe(0)
  expect(getNativeChatRestartOffers().size).toBe(0)
})

// A server rolled back to a build without the capability must not keep a listing no click clears.
it('clears a listing once the server definitively no longer supports it', async () => {
  await connect({ runtimeId: 'r2' })
  mocks.support.mockResolvedValue('unsupported')
  expect((await readNativeChatRestartMachine(TARGET)).kind).toBe('unsupported')
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
})

// A failed probe proves nothing: it neither hides the offer nor spends the toast.
it('treats a failed capability probe like a failed read, and announces on the next good one', async () => {
  mocks.support.mockResolvedValue('unknown')
  stageServer({ runtimeId: 'r2' })
  renderHook(() => useNativeChatRestartOfferSources(false))
  await vi.waitFor(() => expect(mocks.support).toHaveBeenCalled())
  await settle()
  expect(offerReads()).toBe(0)
  expect(toast).not.toHaveBeenCalled()
  mocks.support.mockResolvedValue('supported')
  await readNativeChatRestartMachine(TARGET)
  expect(toast).toHaveBeenCalledTimes(1)
  mocks.support.mockResolvedValue('unknown')
  expect((await readNativeChatRestartMachine(TARGET)).kind).toBe('unavailable')
  expect(getNativeChatRestartOffers().get(MACHINE)?.candidates).toHaveLength(2)
})

it('retries a failed read while the connection holds, then stops', async () => {
  vi.useFakeTimers()
  mocks.rpc.mockRejectedValue(new Error('server still starting'))
  stageServer({ runtimeId: 'r2' })
  renderHook(() => useNativeChatRestartOfferSources(false))
  await vi.advanceTimersByTimeAsync(0)
  expect(offerReads()).toBe(1)
  serveOffers([row('a', 'own')])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(offerReads()).toBe(2)
  expect(toast).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(offerReads()).toBe(2)
})

it('gives up retrying after a few attempts', async () => {
  vi.useFakeTimers()
  mocks.rpc.mockRejectedValue(new Error('unreachable'))
  stageServer({ runtimeId: 'r2' })
  renderHook(() => useNativeChatRestartOfferSources(false))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(offerReads()).toBe(4)
})

it("keeps a server's offer through a failed read, and drops it only for an unsupported host", async () => {
  await connect({ runtimeId: 'r2' })
  mocks.rpc.mockRejectedValueOnce(new Error('connection lost'))
  expect((await readNativeChatRestartMachine(TARGET)).kind).toBe('unavailable')
  expect(getNativeChatRestartOffers().get(MACHINE)?.candidates).toHaveLength(2)
  mocks.rpc.mockRejectedValueOnce(
    Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
  )
  expect((await readNativeChatRestartMachine(TARGET)).kind).toBe('unsupported')
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
})

// An older read answering after a newer one must not replace it, nor decide anything.
it('publishes and decides only the newest answer for a machine', async () => {
  await connect({ runtimeId: 'r2' })
  let answerOld: (value: unknown) => void = () => {}
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answerOld = resolve
      })
  )
  const older = readNativeChatRestartMachine(TARGET)
  await settle()
  serveOffers([])
  await readNativeChatRestartMachine(TARGET)
  answerOld({ sessions: [row('a', 'own', 'update', RECORDED_AT + 9)], failed: [] })
  expect(await older).toMatchObject({ kind: 'answered', published: false })
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
  expect(toast).toHaveBeenCalledTimes(1)
})

// A read issued before a dismiss must not restore what the dismiss removed.
it('lets a dismiss issued after a read outrank that read’s late answer', async () => {
  await connect({ runtimeId: 'r2' })
  let answerRead: (value: unknown) => void = () => {}
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answerRead = resolve
      })
  )
  const reading = readNativeChatRestartMachine(TARGET)
  await settle()
  mocks.rpc.mockResolvedValue({ dismissed: 2, sessions: [], failed: [] })
  await dismissNativeChatRestartOffer(MACHINE)
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
  answerRead({ sessions: [row('a', 'own'), row('b', 'other-device')], failed: [] })
  expect(await reading).toMatchObject({ kind: 'answered', published: false })
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
})

it('names every chat with the interruption it listed when dismissing on a server', async () => {
  await connect({ runtimeId: 'r2' })
  mocks.rpc.mockResolvedValue({ dismissed: 2, sessions: [], failed: [] })
  await dismissNativeChatRestartOffer(MACHINE)
  expect(callsTo('agentSession.restartResumableDismiss').at(-1)?.slice(1)).toEqual([
    'agentSession.restartResumableDismiss',
    {
      sessionIds: ['a', 'b'],
      offers: [
        { sessionId: 'a', recordedAt: RECORDED_AT },
        { sessionId: 'b', recordedAt: RECORDED_AT }
      ]
    },
    { expectedEnvironmentPairingRevision: 1 }
  ])
})

// Dismissing is bookkeeping: a refusal re-reads the list, which keeps the offer, and says nothing.
it('sends nothing and raises no toast for a dismiss when the server cannot be probed', async () => {
  await connect({ runtimeId: 'r2' })
  const toasts = toastTitles().length
  const listed = getNativeChatRestartOffers().get(MACHINE)
  mocks.support.mockResolvedValue('unknown')
  await dismissNativeChatRestartOffer(MACHINE)
  await settle()
  expect(callsTo('agentSession.restartResumableDismiss')).toEqual([])
  expect(toastTitles()).toHaveLength(toasts)
  // The re-read could not reach the server either, so the last answer stands.
  expect(getNativeChatRestartOffers().get(MACHINE)).toBe(listed)
})

// The host re-derives which named chats it still offers, so a restart since the listing is fine.
it('acts under the pairing the offer was listed from, whatever runtime answers now', async () => {
  await connect({ runtimeId: 'r2' })
  const options = vi.mocked(toast).mock.calls[0]?.[1]
  stageServer({ runtimeId: 'r3' })
  press(options?.action)
  await settle()
  expect(callsTo('agentSession.restartContinue')[0]?.[3]).toEqual({
    expectedEnvironmentPairingRevision: 1
  })
})

it('says which chats could not be resumed when the server was re-paired before the call left', async () => {
  await connect({ runtimeId: 'r2' })
  mocks.rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartContinue') {
      throw Object.assign(new Error('runtime_environment_changed'), {
        code: 'runtime_environment_changed'
      })
    }
    return { sessions: [row('a', 'own')] }
  })
  await continueNativeChatRestartOffers([{ machine: MACHINE, sessionIds: ['a'] }])
  expect(toastTitles()).toContain('1 chat on studio-mac couldn’t be resumed')
  expect(toastTitles().some((title) => title.includes('unconfirmed'))).toBe(false)
})

it('retires the old pairing’s offers, decisions and toast on a re-pair', async () => {
  await connect({ runtimeId: 'r2' })
  const options = vi.mocked(toast).mock.calls[0]?.[1]
  // The new pairing cannot be read yet: nothing from the old one may stand in for its answer.
  mocks.rpc.mockRejectedValue(new Error('connection lost'))
  stageServer({ runtimeId: 'r2', pairingRevision: 2 })
  await vi.waitFor(() => expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false))
  press(options?.action)
  await settle()
  expect(continueCalls()).toEqual([])
  expect(toastTitles()).toContain('1 chat on studio-mac couldn’t be resumed')
  // Once readable, the new pairing's own chats are its own decision.
  serveOffers([row('a', 'own')])
  await readNativeChatRestartMachine(TARGET)
  expect(
    toastTitles().filter((title) => title === 'studio-mac restarted for an update')
  ).toHaveLength(2)
})

it('drops an action answer that lands after a re-pair', async () => {
  await connect({ runtimeId: 'r2' })
  let answer: (value: unknown) => void = () => {}
  mocks.rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartContinue'
      ? new Promise((resolve) => {
          answer = resolve
        })
      : Promise.reject(new Error('new pairing not readable yet'))
  )
  const resuming = continueNativeChatRestartOffers([{ machine: MACHINE, sessionIds: ['a'] }])
  await settle()
  stageServer({ runtimeId: 'r9', pairingRevision: 2 })
  await vi.waitFor(() => expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false))
  answer({ continued: [], sessions: [row('b', 'other-device')], failed: [] })
  await resuming
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
})

it('does not read the old pairing’s answer into a re-paired server while probing', async () => {
  stageServer({ runtimeId: 'r2' })
  let probed: (value: 'supported') => void = () => {}
  mocks.support.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        probed = resolve
      })
  )
  const reading = readNativeChatRestartMachine(TARGET)
  replaceRuntimeEnvironmentRevisions([{ id: SERVER, createdAt: 1, pairingRevision: 2 }])
  probed('supported')
  expect((await reading).kind).toBe('unavailable')
  expect(offerReads()).toBe(0)
})

it('reads the machine again when a later read overtook an action’s answer', async () => {
  await connect({ runtimeId: 'r2' })
  let answer: (value: unknown) => void = () => {}
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  const resuming = continueNativeChatRestartOffers([{ machine: MACHINE, sessionIds: ['a'] }])
  await settle()
  await readNativeChatRestartMachine(TARGET)
  const before = offerReads()
  serveOffers([row('b', 'other-device')])
  answer({ continued: [{ sessionId: 'a', outcome: 'continued' }], sessions: [], failed: [] })
  await resuming
  expect(offerReads()).toBe(before + 1)
  expect(
    getNativeChatRestartOffers()
      .get(MACHINE)
      ?.candidates.map((entry) => entry.sessionId)
  ).toEqual(['b'])
})

it('forgets a server this desktop no longer pairs with', async () => {
  // Decided about in an earlier run, and unpaired since.
  window.localStorage.setItem(
    'orca.nativeChatRestartDecided.v1',
    JSON.stringify({ 'unpaired-earlier': ['a\u00001'] })
  )
  await connect({ runtimeId: 'r2' })
  expect(window.localStorage.length).toBe(1)
  useAppStore.setState({ runtimeEnvironments: [] })
  expect(getNativeChatRestartOffers().has(MACHINE)).toBe(false)
  expect(window.localStorage.length).toBe(0)
})

// Only this computer's launch read raises the dialog by itself, and only over the user's own chats.
it("asks for the dialog on this computer when its launch read finds the user's own chats", async () => {
  mocks.rpc.mockImplementation(async (target) =>
    target.kind === 'local' ? { sessions: [row('l1', 'own')] } : { sessions: [] }
  )
  renderHook(() => useNativeChatRestartOfferSources(true))
  await vi.waitFor(() =>
    expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: 'local' })
  )
})

// The launch asks about the user's own chats here; an automation's or another device's alone never
// open the dialog, launch after launch.
it.each(['automation', 'other-device', 'server-made'] as const)(
  'never raises the launch dialog for chats here that are only %s',
  async (origin) => {
    mocks.rpc.mockImplementation(async (target) =>
      target.kind === 'local' ? { sessions: [row('l1', origin)] } : { sessions: [] }
    )
    for (let launch = 0; launch < 2; launch += 1) {
      _resetNativeChatRestartOffer()
      const { unmount } = renderHook(() => useNativeChatRestartOfferSources(true))
      await vi.waitFor(() => expect(getNativeChatRestartOffers().get('local')).toBeDefined())
      unmount()
      expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
      expect(getNativeChatRestartOffers().get('local')?.candidates).toHaveLength(1)
    }
  }
)

it('never opens the dialog by itself for a paired server', async () => {
  await connect({ runtimeId: 'r2' })
  expect(toast).toHaveBeenCalledTimes(1)
  expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
})
