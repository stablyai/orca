import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { openOnPairedServer } from './paired-server-open'
import { structuredSessionOpenFeedback } from './activate-ai-vault-structured-session'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.mocked(toast.error).mockReset()
})

const paired = (...environments: { id: string; name: string }[]) =>
  useAppStore.setState({
    runtimeEnvironmentCatalogHydrated: true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the open reads only id and name.
    runtimeEnvironments: environments as unknown as PublicKnownRuntimeEnvironment[]
  })

// A worker on a server this desktop no longer pairs with is never asked for there: no call, no Retry.
it('names the lost pairing without calling a server this desktop no longer pairs with', async () => {
  paired({ id: 'env_other', name: 'Other' })
  const open = vi.fn()
  const result = await openOnPairedServer('env_gone', 'Worker', structuredSessionOpenFeedback, open)
  expect(open).not.toHaveBeenCalled()
  expect(result).toEqual({ kind: 'failed', failure: { reason: 'unknown', beforeEffects: true } })
  expect(toast.error).toHaveBeenCalledWith(
    "Worker runs on a computer this Orca is no longer paired with, so it can't open it."
  )
})

// A call that throws (an offline server, a pairing removed mid-open) settles with the server's name.
it('settles a call to the server that throws, naming the server', async () => {
  paired({ id: 'env_server', name: 'windows 2' })
  const open = vi
    .fn()
    .mockRejectedValue(new Error("Error invoking remote method 'runtimeEnvironments:call'"))
  const result = await openOnPairedServer(
    'env_server',
    'Worker',
    structuredSessionOpenFeedback,
    open
  )
  expect(open).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'env_server' },
    expect.anything()
  )
  expect(result).toEqual({ kind: 'failed', failure: { reason: 'unknown', beforeEffects: true } })
  expect(toast.error).toHaveBeenCalledWith("Orca couldn't reach windows 2 to open Worker.")
})

// The server answered that it has no such worker: say so naming it, not the generic "can't find" text.
it('names the server when it finds no chat or terminal for the worker', async () => {
  paired({ id: 'env_server', name: 'windows 2' })
  await openOnPairedServer(
    'env_server',
    'Worker',
    structuredSessionOpenFeedback,
    async (_host, feedback) => {
      feedback.notLocated?.('Worker')
      return { kind: 'failed', failure: { reason: 'unknown', beforeEffects: true } }
    }
  )
  expect(toast.error).toHaveBeenCalledWith('Worker is no longer running on windows 2.')
})

// The server's environment IDs name its own pairings: one it reports never becomes, or is replaced by, one of ours.
it('refuses a terminal the server places on another computer instead of addressing it to the server', async () => {
  paired({ id: 'env_server', name: 'windows 2' })
  const result = await openOnPairedServer(
    'env_server',
    'Worker',
    structuredSessionOpenFeedback,
    async () => ({
      kind: 'terminal',
      handle: 'term_far',
      environmentId: 'env_third'
    })
  )
  expect(result).toEqual({ kind: 'failed', failure: { reason: 'unknown', beforeEffects: true } })
  const own = await openOnPairedServer(
    'env_server',
    'Worker',
    structuredSessionOpenFeedback,
    async () => ({
      kind: 'terminal',
      handle: 'term_here'
    })
  )
  expect(own).toEqual({ kind: 'terminal', handle: 'term_here', environmentId: 'env_server' })
})
