// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import { BotItemLinkChips } from './BotItemLinkChips'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))

const localCall = vi.fn()

beforeEach(() => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Stop reaches only runtime.call here.
  window.api = { runtime: { call: localCall } } as unknown as typeof window.api
})

afterEach(() => {
  cleanup()
  localCall.mockReset()
  vi.mocked(callRuntimeRpc).mockReset()
  vi.mocked(toast.error).mockReset()
})

// Listed by the paired computer that is its home, as the sidebar lists it.
const pairedBot = stampBotHost('runtime:env_m4', fixtureCos)

const worker: BotItemLinkView = {
  kind: 'dispatch',
  ref: 'ctx_remote000001',
  latest: null,
  title: 'Prod scan',
  state: 'working',
  host: null,
  startedAt: 1,
  settledAt: null,
  report: null,
  pr: null
}

function clickStop(bot: Bot): void {
  render(
    <TooltipProvider>
      <BotItemLinkChips bot={bot} links={[worker]} chat="Home Chat" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Stop Prod scan' }))
}

// The bot's home is a paired computer, so its worker's Dispatch is there: this computer has no record of it.
it('stops a worker of a bot on a paired computer on that computer, not this one', async () => {
  vi.mocked(callRuntimeRpc).mockResolvedValue({ dispatchId: worker.ref, state: 'stopped' })
  localCall.mockResolvedValue({
    ok: false,
    error: { code: 'dispatch_not_found', message: `Dispatch ${worker.ref} was not found.` }
  })
  clickStop(pairedBot)
  await waitFor(() =>
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env_m4' },
      'orchestration.workerStop',
      { dispatch: worker.ref }
    )
  )
  expect(localCall).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
})

// What that computer can't prove stopped is still said, in its own words.
it("says so when the paired computer can't confirm the stop", async () => {
  vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('Remote runtime is not reachable.'))
  clickStop(pairedBot)
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Orca couldn’t confirm the worker stopped.', {
      description: 'Remote runtime is not reachable.'
    })
  )
  expect(localCall).not.toHaveBeenCalled()
})

// This computer's own bot keeps the local stop, with its request id for replay.
it("stops this computer's bot's worker here", async () => {
  localCall.mockResolvedValue({ ok: true, result: { dispatchId: worker.ref, state: 'stopped' } })
  clickStop(fixtureCos)
  await waitFor(() =>
    expect(localCall).toHaveBeenCalledWith({
      method: 'orchestration.workerStop',
      params: { dispatch: worker.ref },
      orchestration: { contractVersion: expect.any(Number), requestId: expect.any(String) }
    })
  )
  expect(callRuntimeRpc).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
})
