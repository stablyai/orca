import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import { lastToastShow } from './native-chat-resume-toast.test-support'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest,
  subscribeNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import {
  forgetNativeChatRestartMachine,
  getNativeChatRestartOffers,
  readNativeChatRestartMachine
} from './native-chat-resume-on-restart-store'
import { continueNativeChatRestartOffers } from './native-chat-restart-offer-actions'
import { _resetNativeChatRestartOffer } from './native-chat-restart-offer-triggers'
import { reopenNativeChatRestartOffer } from './native-chat-restart-offer-reopen'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { pairedEnvironment, verifiedConnection } from './native-chat-restart-offer-test-support'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  pairedRestartOffersSupport: async () => 'supported',
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }))

const LOCAL = { kind: 'local' } as const
const SERVER = 'studio'
const STUDIO = { kind: 'environment', environmentId: SERVER } as const

const offered: ResumeCandidate[] = ['a', 'b'].map((sessionId) => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1_800_000_000_000,
  origin: 'own'
}))

function failedIds(machine = 'local'): string[] {
  return (getNativeChatRestartOffers().get(machine)?.failed ?? []).map((entry) => entry.sessionId)
}

function offerIds(machine = 'local'): string[] {
  return (getNativeChatRestartOffers().get(machine)?.candidates ?? []).map(
    (entry) => entry.sessionId
  )
}

function pairStudio(pairingRevision = 1): void {
  replaceRuntimeEnvironmentRevisions([{ id: SERVER, createdAt: 1, pairingRevision }])
  useAppStore.setState({
    runtimeEnvironments: [pairedEnvironment(SERVER, 'studio-mac')],
    runtimeEnvironmentCatalogHydrated: true,
    runtimeStatusByEnvironmentId: new Map([
      [
        SERVER,
        verifiedConnection({ environmentId: SERVER, runtimeId: 'runtime-1', pairingRevision })
      ]
    ])
  })
}

/** Every change to the dialog request from here on, so an open that closes again is seen. */
function recordDialogRequests(): unknown[] {
  const seen: unknown[] = []
  unsubscribe = subscribeNativeChatResumeOnRestartDialog(() => {
    seen.push(getNativeChatResumeOnRestartDialogRequest())
  })
  return seen
}

let unsubscribe = () => {}

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  vi.mocked(toast).mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  unsubscribe()
  unsubscribe = () => {}
  vi.mocked(console.warn).mockRestore()
  _resetNativeChatRestartOffer()
})

/** The host lists both chats, then loses every later call. */
function hostLostAfterListing(): void {
  let reachable = true
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable' && reachable) {
      return { sessions: offered, failed: [] }
    }
    reachable = false
    throw new Error('host unreachable')
  })
}

// A click and an opted-in automatic resume both name the user's own chats, so they share one path.
const resumeBoth = () =>
  continueNativeChatRestartOffers([{ machine: 'local', sessionIds: ['a', 'b'] }])

// With the host unreachable there is no list to narrow by: every chat the resume reported failed,
// and nothing is listed for Show to open.
it('counts every chat of a lost resume when the host cannot be read either', async () => {
  hostLostAfterListing()
  await readNativeChatRestartMachine(LOCAL)
  await resumeBoth()
  expect(vi.mocked(toast).mock.calls).toEqual([['2 chats couldn’t be resumed', {}]])
})

// The re-read lists the chats the lost request reported as failed, so the one toast keeps Show.
it('answers a resume that loses its request with one toast and Show', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered, failed: [] }
    }
    throw new Error('response lost')
  })
  await readNativeChatRestartMachine(LOCAL)
  await resumeBoth()
  expect(failedIds()).toEqual(['a', 'b'])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    '2 chats couldn’t be resumed'
  ])
  expect(lastToastShow()).toBeDefined()
})

// The chats it resumed ride along under the one it could not.
it('answers a mixed resume with one toast', async () => {
  const failed = [{ ...offered[1]!, failedAt: 1, outcome: 'refused', reason: 'unknown' }]
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered, failed: [] }
      : {
          continued: [
            { sessionId: 'a', outcome: 'continued' },
            { sessionId: 'b', outcome: 'refused' }
          ],
          sessions: [],
          failed
        }
  )
  await readNativeChatRestartMachine(LOCAL)
  await resumeBoth()
  expect(vi.mocked(toast).mock.calls).toEqual([
    ['1 chat couldn’t be resumed', expect.objectContaining({ description: 'Resumed 1 chat' })]
  ])
  expect(lastToastShow()).toBeDefined()
})

// Between the listing and the request every chat moved on by itself: nothing happened to report.
it('raises no toast when the host had nothing left to resume', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered, failed: [] }
      : { continued: [], sessions: [], failed: [] }
  )
  await readNativeChatRestartMachine(LOCAL)
  await resumeBoth()
  expect(toast).not.toHaveBeenCalled()
})

// The agent was seen carrying on while the toast was up, so the host retired the failure. That
// cannot bring the attention back, but the run's summary was never seen, so Show still opens it.
it('opens the retained summary from Show after the host withdraws a failure', async () => {
  let failed = [{ ...offered[0]!, failedAt: 1, outcome: 'unconfirmed', reason: 'unknown' }]
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: [], failed }
      : { continued: [{ sessionId: 'a', outcome: 'unknown' }], sessions: [], failed }
  )
  await readNativeChatRestartMachine(LOCAL)
  await continueNativeChatRestartOffers([{ machine: 'local', sessionIds: ['a'] }])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    'Couldn’t confirm 1 chat was resumed'
  ])
  failed = []
  const requests = recordDialogRequests()
  lastToastShow()?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rpc.mock.calls.at(-1)?.[1]).toBe('agentSession.restartResumable')
  expect(getNativeChatRestartOffers().get('local')).toBeUndefined()
  expect(requests).toEqual([{ focus: 'local' }])
})

// Session ids are each host's own: a lost request to one machine marks only that machine's rows.
it('marks a lost paired resume on that server only, never a same-id chat here', async () => {
  pairStudio()
  rpc.mockImplementation(async (target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered, failed: [] }
    }
    if (target.kind === 'environment') {
      throw new Error('response lost')
    }
    return { continued: [], sessions: offered, failed: [] }
  })
  await readNativeChatRestartMachine(LOCAL)
  await readNativeChatRestartMachine(STUDIO)
  await continueNativeChatRestartOffers([{ machine: `environment:${SERVER}`, sessionIds: ['a'] }])
  expect(failedIds(`environment:${SERVER}`)).toEqual(['a'])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    '1 chat on studio-mac couldn’t be resumed'
  ])
  await readNativeChatRestartMachine(LOCAL)
  expect(offerIds()).toEqual(['a', 'b'])
  expect(failedIds()).toEqual([])
})

// Re-paired or forgotten, the server's marks go with its offers: a later pairing starts clean.
it('ends a server’s marks when the desktop forgets it', async () => {
  pairStudio()
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered, failed: [] }
    }
    throw new Error('response lost')
  })
  await readNativeChatRestartMachine(STUDIO)
  await continueNativeChatRestartOffers([{ machine: `environment:${SERVER}`, sessionIds: ['a'] }])
  expect(failedIds(`environment:${SERVER}`)).toEqual(['a'])
  forgetNativeChatRestartMachine(`environment:${SERVER}`)
  await readNativeChatRestartMachine(STUDIO)
  expect(offerIds(`environment:${SERVER}`)).toEqual(['a', 'b'])
  expect(failedIds(`environment:${SERVER}`)).toEqual([])
})

// The host reserved the chats and carries on with them, but the answer never came back: the reserved
// chats leave its list, so nothing may count them as failed or drop them. One toast still says so.
it('counts a paired resume whose answer was lost as unconfirmed once the server stops listing it', async () => {
  pairStudio()
  let reserved = false
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: reserved ? [] : offered, failed: [] }
    }
    reserved = true
    throw Object.assign(new Error('Timed out waiting for runtime response'), {
      code: 'runtime_timeout'
    })
  })
  await readNativeChatRestartMachine(STUDIO)
  await continueNativeChatRestartOffers([
    { machine: `environment:${SERVER}`, sessionIds: ['a', 'b'] }
  ])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    'Couldn’t confirm 2 chats on studio-mac were resumed'
  ])
  expect(lastToastShow()).toBeDefined()
})

// The user's click is never lost to bookkeeping: a server out of contact opens on its last listing,
// without a read that would hold the dialog back until it timed out.
it('opens a disconnected server’s last listing from Show without reading it', async () => {
  pairStudio()
  rpc.mockResolvedValue({ sessions: offered, failed: [] })
  await readNativeChatRestartMachine(STUDIO)
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  const reads = rpc.mock.calls.length
  await reopenNativeChatRestartOffer([`environment:${SERVER}`])
  expect(rpc.mock.calls).toHaveLength(reads)
  expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: `environment:${SERVER}` })
})

it('opens a connected server’s last listing when its re-read fails', async () => {
  pairStudio()
  rpc.mockResolvedValueOnce({ sessions: offered, failed: [] })
  await readNativeChatRestartMachine(STUDIO)
  rpc.mockRejectedValue(new Error('host unreachable'))
  const requests = recordDialogRequests()
  await reopenNativeChatRestartOffer([`environment:${SERVER}`])
  expect(rpc.mock.calls.at(-1)?.[1]).toBe('agentSession.restartResumable')
  expect(requests).toEqual([{ focus: `environment:${SERVER}` }])
})

it('opens nothing for a connected server whose re-read lists nothing', async () => {
  pairStudio()
  rpc.mockResolvedValueOnce({ sessions: offered, failed: [] })
  await readNativeChatRestartMachine(STUDIO)
  rpc.mockResolvedValue({ sessions: [], failed: [] })
  const requests = recordDialogRequests()
  await reopenNativeChatRestartOffer([`environment:${SERVER}`])
  expect(requests).toEqual([])
})

// The server took the request, then the link dropped: neither the answer nor a re-read came back.
// It may be continuing every chat, so none is reported as failed, which would invite a second send.
it('counts a paired resume as unconfirmed when its answer and the re-read are both lost', async () => {
  pairStudio()
  let down = false
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable' && !down) {
      return { sessions: offered, failed: [] }
    }
    down = true
    throw new Error('Remote runtime connection closed')
  })
  await readNativeChatRestartMachine(STUDIO)
  await continueNativeChatRestartOffers([
    { machine: `environment:${SERVER}`, sessionIds: ['a', 'b'] }
  ])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    'Couldn’t confirm 2 chats on studio-mac were resumed'
  ])
  // The last listing still names them, so Show has something to open.
  expect(lastToastShow()).toBeDefined()
})

it('offers no Show for a lost paired resume once nothing of that server is listed', async () => {
  pairStudio()
  rpc.mockResolvedValueOnce({ sessions: offered, failed: [] })
  await readNativeChatRestartMachine(STUDIO)
  rpc.mockImplementation(async () => {
    // Re-paired while the call was out: the old pairing's listing is gone with it.
    forgetNativeChatRestartMachine(`environment:${SERVER}`)
    throw new Error('Remote runtime connection closed')
  })
  await continueNativeChatRestartOffers([{ machine: `environment:${SERVER}`, sessionIds: ['a'] }])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    'Couldn’t confirm 1 chat on studio-mac was resumed'
  ])
  expect(lastToastShow()).toBeUndefined()
})

/** Transport up, but the server's runtime did not answer its status probe. */
function studioRuntimeUnavailable(): void {
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(SERVER)!
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([
      [SERVER, { ...entry, snapshot: { ...entry.snapshot!, verification: 'unavailable' } }]
    ])
  })
}

it('opens at once on the last listing of a server whose runtime is not answering', async () => {
  pairStudio()
  rpc.mockResolvedValueOnce({ sessions: offered, failed: [] })
  await readNativeChatRestartMachine(STUDIO)
  studioRuntimeUnavailable()
  const reads = rpc.mock.calls.length
  await reopenNativeChatRestartOffer([`environment:${SERVER}`])
  expect(rpc.mock.calls).toHaveLength(reads)
  expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: `environment:${SERVER}` })
})

// A click is never held for long by a slow server: past the budget the dialog opens on the last
// listing, and the late answer lands in it like any other read, keeping the same opening.
it('opens on the last listing once a connected server’s read outlasts its budget', async () => {
  vi.useFakeTimers()
  try {
    pairStudio()
    rpc.mockResolvedValueOnce({ sessions: offered, failed: [] })
    await readNativeChatRestartMachine(STUDIO)
    let answer: (value: unknown) => void = () => {}
    rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const opening = reopenNativeChatRestartOffer([`environment:${SERVER}`])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    await opening
    const opened = getNativeChatResumeOnRestartDialogRequest()
    expect(opened).toEqual({ focus: `environment:${SERVER}` })
    answer({ sessions: [offered[1]!], failed: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(offerIds(`environment:${SERVER}`)).toEqual(['b'])
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(opened)
  } finally {
    vi.useRealTimers()
  }
})
