// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store/index'
import { fixtureCos } from '../../component-fixtures/fixture-bot-panel'
import { clientMadeFailureData } from '../../../../shared/remote-runtime/rpc/runtime-rpc-client-made-failure'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import type { Bot } from '../../../../shared/bot-types'
import type { BotItemLinkView } from '../../../../shared/bots/bot-items'
import type { BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { BotItemLinkChips } from './items/BotItemLinkChips'
import { BotChatTreeWorkerRow } from './BotChatTreeWorkerRow'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const localCall = vi.fn()
const pairedCall = vi.fn()
let originalApi: typeof window.api

beforeEach(() => {
  originalApi = window.api
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Stop reaches only these two calls.
  window.api = {
    runtime: { call: localCall },
    runtimeEnvironments: { call: pairedCall }
  } as unknown as typeof window.api
  useAppStore.setState({
    runtimeEnvironmentCatalogHydrated: true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop reads only id and name.
    runtimeEnvironments: [
      { id: 'env_m4', name: 'M4 Air' }
    ] as unknown as PublicKnownRuntimeEnvironment[]
  })
})

afterEach(() => {
  cleanup()
  window.api = originalApi
  useAppStore.setState(useAppStore.getInitialState(), true)
  clearRuntimeCompatibilityCache()
  localCall.mockReset()
  pairedCall.mockReset()
  vi.mocked(toast.error).mockReset()
})

// Listed by the paired computer that is its home, as the sidebar lists it.
const pairedBot = stampBotHost('runtime:env_m4', fixtureCos)
const dispatch = 'ctx_remote000001'

const link: BotItemLinkView = {
  kind: 'dispatch',
  ref: dispatch,
  latest: null,
  title: 'Prod scan',
  state: 'working',
  host: null,
  startedAt: 1,
  settledAt: null,
  report: null,
  pr: null
}

function clickChipStop(bot: Bot): void {
  render(
    <TooltipProvider>
      <BotItemLinkChips bot={bot} links={[link]} chat="Home Chat" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Stop Prod scan' }))
}

const answered = (result: unknown) => ({ id: 'rpc', ok: true, result, _meta: { runtimeId: 'm4' } })
const refused = (code: string, message: string, data?: unknown) => ({
  id: 'rpc',
  ok: false,
  error: { code, message, ...(data ? { data } : {}) },
  _meta: { runtimeId: 'm4' }
})

// The paired computer's version check (the real probe) passes; its stop answers `stop`.
const compatible = answered({
  runtimeId: 'm4',
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION
})
function pairedAnswers(stop: unknown): void {
  pairedCall.mockImplementation(async (args: { method: string }) =>
    args.method === 'status.get' ? compatible : stop
  )
}
const stopCalls = () =>
  pairedCall.mock.calls.filter(([args]) => args.method === 'orchestration.workerStop')
async function toastShown(): Promise<[unknown, unknown]> {
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  const [title, options] = vi.mocked(toast.error).mock.calls[0]
  return [title, options]
}

// The bot's home is a paired computer, so its worker's Dispatch is there. The stop carries a request
// id, which that computer needs to stop a worker it placed on a third computer.
it('stops a worker of a bot on a paired computer on that computer, with a request id', async () => {
  pairedAnswers(answered({ dispatchId: dispatch, state: 'stopped' }))
  clickChipStop(pairedBot)
  await waitFor(() =>
    expect(pairedCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env_m4',
        method: 'orchestration.workerStop',
        params: { dispatch },
        orchestrationRequestId: expect.any(String)
      })
    )
  )
  // A stop there can take longer than an ordinary call's 15 s.
  expect(stopCalls()[0][0].timeoutMs).toBeGreaterThan(15_000)
  expect(localCall).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
})

// The bot's chat tree row (also the item's "+N" rows) sends its Stop to the same computer.
it("stops from a paired bot's chat tree row on that computer", async () => {
  pairedAnswers(answered({ dispatchId: dispatch, state: 'stopped' }))
  const worker: BotChatTreeWorker = {
    key: dispatch,
    title: 'Prod scan',
    state: 'running',
    startedAt: 1,
    dispatchId: dispatch
  }
  render(
    <TooltipProvider>
      <BotChatTreeWorkerRow bot={pairedBot} worker={worker} chat="Home Chat" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Stop Prod scan' }))
  await waitFor(() =>
    expect(pairedCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env_m4', method: 'orchestration.workerStop' })
    )
  )
  expect(localCall).not.toHaveBeenCalled()
})

// This Orca proves the stop never left it (no connection): the notice names the computer and the worker.
it('names the paired computer when the stop never reached it', async () => {
  pairedAnswers(
    refused(
      'remote_runtime_unavailable',
      'Could not connect to the remote Orca runtime.',
      clientMadeFailureData(undefined, true)
    )
  )
  clickChipStop(pairedBot)
  const [title, options] = await toastShown()
  expect(title).toEqual(expect.stringContaining('M4 Air'))
  expect(title).toEqual(expect.stringContaining('Prod scan'))
  expect(options).toBeUndefined()
})

// The version check before the stop can't reach the computer (a cold probe, no marker on its failure):
// the stop was never sent, so the notice names the computer.
it('names the paired computer when its version check fails before the stop', async () => {
  pairedCall.mockImplementation(async (args: { method: string }) =>
    args.method === 'status.get'
      ? refused('remote_runtime_unavailable', 'Could not connect to the remote Orca runtime.')
      : answered({ dispatchId: dispatch, state: 'stopped' })
  )
  clickChipStop(pairedBot)
  const [title, options] = await toastShown()
  expect(stopCalls()).toHaveLength(0)
  expect(title).toEqual(expect.stringContaining('M4 Air'))
  expect(title).toEqual(expect.stringContaining('Prod scan'))
  expect(options).toBeUndefined()
})

// This Orca's own status check gives up (its waiter timed out, its SSH tunnel failed, or it is backing
// off) with `runtime_unavailable`: still before the stop, so the notice names the computer.
it("names the paired computer when this Orca's status check can't reach it", async () => {
  pairedCall.mockImplementation(async (args: { method: string }) =>
    args.method === 'status.get'
      ? refused('runtime_unavailable', 'Timed out waiting for the remote Orca runtime.')
      : answered({ dispatchId: dispatch, state: 'stopped' })
  )
  clickChipStop(pairedBot)
  const [title, options] = await toastShown()
  expect(stopCalls()).toHaveLength(0)
  expect(title).toEqual(expect.stringContaining('M4 Air'))
  expect(title).toEqual(expect.stringContaining('Prod scan'))
  expect(options).toBeUndefined()
})

// Sent, then no reply in time: the worker may be stopped, so this is unconfirmed, not unreachable.
it('says the stop is unconfirmed when the paired computer times out after the send', async () => {
  pairedAnswers(
    refused(
      'runtime_timeout',
      'Timed out waiting for the remote Orca runtime to respond.',
      clientMadeFailureData(undefined, false)
    )
  )
  clickChipStop(pairedBot)
  const [title, options] = await toastShown()
  expect(title).not.toEqual(expect.stringContaining('M4 Air'))
  expect(options).toEqual({ description: expect.stringContaining('M4 Air') })
})

// A full call queue says nothing about the connection: unconfirmed, in its own words.
it("keeps a full call queue's own words, unconfirmed", async () => {
  const message = 'Remote runtime call queue is full; retry after current calls finish.'
  pairedAnswers(
    refused('runtime_rpc_queue_overloaded', message, clientMadeFailureData(undefined, false))
  )
  clickChipStop(pairedBot)
  const [title, options] = await toastShown()
  expect(title).not.toEqual(expect.stringContaining('M4 Air'))
  expect(options).toEqual({ description: message })
})

// The paired computer answered, about a third computer it couldn't reach (its data even says "unsent"):
// its words, not "couldn't reach M4 Air".
it("keeps the paired computer's own answer when it couldn't reach another computer", async () => {
  const message = 'Could not check whether the user kept Dispatch ctx_remote000001 open on C.'
  pairedAnswers(refused('remote_runtime_unavailable', message, { requestSent: false }))
  clickChipStop(pairedBot)
  const [title, options] = await toastShown()
  expect(title).not.toEqual(expect.stringContaining('M4 Air'))
  expect(options).toEqual({ description: message })
})

// An unanswered stop the paired computer still owes keeps its own account of why.
it("shows the paired computer's account of a stop it is still owed", async () => {
  const next = 'C did not answer, so its worker may still run there. Orca keeps trying.'
  pairedAnswers(answered({ dispatchId: dispatch, state: 'stop_requested', server: 'C', next }))
  clickChipStop(pairedBot)
  const [, options] = await toastShown()
  expect(options).toEqual({ description: next })
})

const helperOf = (outcome: string, lastError?: string) => ({
  dispatchId: `ctx_helper_${outcome}`,
  creatorDispatchId: dispatch,
  outcome,
  ...(lastError ? { lastError } : {})
})
const stoppedWith = (...helpers: unknown[]) =>
  answered({
    dispatchId: dispatch,
    state: 'stopped',
    alreadySettled: false,
    processAction: 'closed_agent_terminal',
    helpers
  })

// The worker stopped, but a helper it started could not be proven stopped: that is no clean stop.
it('says so when a helper under the stopped worker is unconfirmed', async () => {
  pairedAnswers(stoppedWith(helperOf('unconfirmed', 'C did not answer.')))
  clickChipStop(pairedBot)
  const [title, options] = await toastShown()
  expect(title).toEqual(expect.stringContaining('Prod scan'))
  expect(options).toEqual({ description: 'C did not answer.' })
})

// A helper still starting is not proven stopped either; one the user kept open is.
it('says so when a helper under the stopped worker is still starting', async () => {
  pairedAnswers(stoppedWith(helperOf('kept_open'), helperOf('starting')))
  clickChipStop(pairedBot)
  const [title] = await toastShown()
  expect(title).toEqual(expect.stringContaining('Prod scan'))
})

// One helper can't say why yet (still starting), a later one can: the notice keeps the reason.
it('keeps the reason of an unconfirmed helper listed after a starting one', async () => {
  pairedAnswers(stoppedWith(helperOf('starting'), helperOf('unconfirmed', 'C did not answer.')))
  clickChipStop(pairedBot)
  const [, options] = await toastShown()
  expect(options).toEqual({ description: 'C did not answer.' })
})

it('is a clean stop when the only helper left running is one the user kept open', async () => {
  pairedAnswers(stoppedWith(helperOf('kept_open'), helperOf('stopped')))
  clickChipStop(pairedBot)
  await waitFor(() => expect(stopCalls()).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(toast.error).not.toHaveBeenCalled()
})

// This computer's own bot keeps the local stop, with its request id for replay.
it("stops this computer's bot's worker here", async () => {
  localCall.mockResolvedValue({ ok: true, result: { dispatchId: dispatch, state: 'stopped' } })
  clickChipStop(fixtureCos)
  await waitFor(() =>
    expect(localCall).toHaveBeenCalledWith({
      method: 'orchestration.workerStop',
      params: { dispatch },
      orchestration: { contractVersion: expect.any(Number), requestId: expect.any(String) }
    })
  )
  expect(pairedCall).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
})
