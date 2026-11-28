// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store/index'
import { fixtureCos } from '../../component-fixtures/fixture-bot-panel'
import { CLIENT_MADE_FAILURE_DATA } from '../../../../shared/remote-runtime/rpc/runtime-rpc-client-made-failure'
import type { Bot } from '../../../../shared/bot-types'
import type { BotItemLinkView } from '../../../../shared/bots/bot-items'
import type { BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { BotItemLinkChips } from './items/BotItemLinkChips'
import { BotChatTreeWorkerRow } from './BotChatTreeWorkerRow'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
// The paired server's version check is not what these cases are about; it passes.
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => null)
}))

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

// The bot's home is a paired computer, so its worker's Dispatch is there. The stop carries a request
// id, which that computer needs to stop a worker it placed on a third computer.
it('stops a worker of a bot on a paired computer on that computer, with a request id', async () => {
  pairedCall.mockResolvedValue(answered({ dispatchId: dispatch, state: 'stopped' }))
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
  expect(pairedCall.mock.calls[0][0].timeoutMs).toBeGreaterThan(15_000)
  expect(localCall).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
})

// The bot's chat tree row (also the item's "+N" rows) sends its Stop to the same computer.
it("stops from a paired bot's chat tree row on that computer", async () => {
  pairedCall.mockResolvedValue(answered({ dispatchId: dispatch, state: 'stopped' }))
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

// No answer at all from the paired computer: the notice names it and the worker.
it("names the paired computer when it can't be reached", async () => {
  pairedCall.mockResolvedValue(
    refused(
      'remote_runtime_unavailable',
      'Could not connect to the remote Orca runtime.',
      CLIENT_MADE_FAILURE_DATA
    )
  )
  clickChipStop(pairedBot)
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  const [title, options] = vi.mocked(toast.error).mock.calls[0]
  expect(title).toEqual(expect.stringContaining('M4 Air'))
  expect(title).toEqual(expect.stringContaining('Prod scan'))
  expect(options).toBeUndefined()
})

// The paired computer answered, about a third computer it couldn't reach: its words, not "couldn't reach M4 Air".
it("keeps the paired computer's own answer when it couldn't reach another computer", async () => {
  const message = 'Could not check whether the user kept Dispatch ctx_remote000001 open on C.'
  pairedCall.mockResolvedValue(refused('remote_runtime_unavailable', message))
  clickChipStop(pairedBot)
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
  const [title, options] = vi.mocked(toast.error).mock.calls[0]
  expect(title).not.toEqual(expect.stringContaining('M4 Air'))
  expect(options).toEqual({ description: message })
})

// The worker stopped, but a helper it started could not be proven stopped: that is no clean stop.
it('says so when a helper under the stopped worker is unconfirmed', async () => {
  pairedCall.mockResolvedValue(
    answered({
      dispatchId: dispatch,
      state: 'stopped',
      alreadySettled: false,
      processAction: 'closed_agent_terminal',
      helpers: [
        {
          dispatchId: 'ctx_helper000001',
          creatorDispatchId: dispatch,
          outcome: 'unconfirmed',
          lastError: 'C did not answer.'
        }
      ]
    })
  )
  clickChipStop(pairedBot)
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), {
      description: 'C did not answer.'
    })
  )
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
