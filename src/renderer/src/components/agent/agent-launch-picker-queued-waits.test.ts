import { afterEach, expect, it, vi } from 'vitest'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { useAppStore } from '@/store'
import { agentPickerModelCatalogReads } from './agent-launch-picker-host-reads'
import { observeAgentPickerAcquisition } from './agent-launch-picker-acquisition'
const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: transport.call
}))
const initial = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initial, true)
  transport.call.mockReset()
})
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [],
  surfaces: ['chat'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}

it('keeps last-good display failed and retries on reopen while support is still pending', async () => {
  const refresh = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const support = Promise.withResolvers<undefined>()
  transport.call.mockImplementation((_target, _method, params) =>
    params.waitForListing
      ? refresh.promise
      : {
          origin: 'probe',
          fetchedAt: 1,
          listingInProgress: true,
          models: [{ id: 'last-good', label: 'Last good', isDefault: false, efforts: [] }]
        }
  )
  let published: AgentPickerEntry[] = []
  const observe = () =>
    observeAgentPickerAcquisition(
      'retry-after-failure',
      [{ ...entry, structuredDefaultsPending: true }],
      {
        ...agentPickerModelCatalogReads({ target: { kind: 'local' }, worktree: 'id:retry' }),
        support: () => support.promise
      },
      {
        selected: () => 'codex',
        publish: (next) => {
          published = next
        }
      }
    )
  const close = observe()
  await expect.poll(() => published[0]?.catalog).toMatchObject({ models: [{ id: 'last-good' }] })
  refresh.reject(new Error('offline'))
  await expect
    .poll(() => published[0])
    .toMatchObject({ catalogRead: 'failed', catalog: { models: [{ id: 'last-good' }] } })
  close()
  transport.call.mockResolvedValue({
    origin: 'probe',
    fetchedAt: 2,
    models: [{ id: 'recovered', label: 'Recovered', isDefault: false, efforts: [] }]
  })
  const reopened = observe()
  try {
    await expect
      .poll(() => published[0])
      .toMatchObject({ catalogRead: 'settled', catalog: { models: [{ id: 'recovered' }] } })
  } finally {
    reopened()
    support.resolve(undefined)
  }
})

it('ignores obsolete success and rejection after a real account change while the replacement is pending', async () => {
  const old = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const middle = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const replacement = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const admitted = Promise.withResolvers<void>(),
    middleAdmitted = Promise.withResolvers<void>(),
    replacementAdmitted = Promise.withResolvers<void>()
  transport.call
    .mockImplementationOnce(() => {
      admitted.resolve()
      return old.promise
    })
    .mockImplementationOnce(() => {
      middleAdmitted.resolve()
      return middle.promise
    })
    .mockImplementationOnce(() => {
      replacementAdmitted.resolve()
      return replacement.promise
    })
  let published: AgentPickerEntry[] = []
  const done = Promise.withResolvers<void>()
  const reads: Promise<AgentSessionModelCatalogResult | undefined>[] = []
  const host = agentPickerModelCatalogReads({ target: { kind: 'local' }, worktree: 'id:replace' })
  const close = observeAgentPickerAcquisition(
    'account-cycle-fence',
    [entry],
    {
      ...host,
      catalog: (...args) => {
        const read = host.catalog(...args)
        reads.push(read)
        return read
      },
      support: async () => undefined
    },
    {
      selected: () => 'codex',
      publish: (next) => {
        published = next
        if (next[0].catalogRead === 'settled') {
          done.resolve()
        }
      }
    }
  )
  try {
    await admitted.promise
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, activeCodexManagedAccountId: 'middle' }
    }))
    await middleAdmitted.promise
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, activeCodexManagedAccountId: 'new-account' }
    }))
    await replacementAdmitted.promise
    old.resolve({
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'old-account', label: 'Old', isDefault: false, efforts: [] }]
    })
    middle.reject(new Error('old transport failed'))
    await Promise.allSettled(reads.slice(0, 2))
    expect(published[0]).toMatchObject({ catalogRead: 'pending', catalog: { origin: 'unknown' } })
    replacement.resolve({
      origin: 'probe',
      fetchedAt: 2,
      models: [{ id: 'new-account', label: 'New', isDefault: false, efforts: [] }]
    })
    await done.promise
    expect(published[0]).toMatchObject({
      catalogRead: 'settled',
      catalog: { models: [{ id: 'new-account' }] }
    })
  } finally {
    close()
    old.resolve({ origin: 'unknown' })
    middle.resolve({ origin: 'unknown' })
    replacement.resolve({ origin: 'unknown' })
  }
})

it('preserves unsupported transport classification instead of settling an unknown answer', async () => {
  transport.call.mockRejectedValue({ code: 'method_not_found' })
  let published: AgentPickerEntry[] = []
  const close = observeAgentPickerAcquisition(
    'unsupported-read',
    [entry],
    {
      ...agentPickerModelCatalogReads({ target: { kind: 'local' }, worktree: 'id:unsupported' }),
      support: async () => undefined
    },
    {
      selected: () => 'codex',
      publish: (next) => {
        published = next
      }
    }
  )
  try {
    await expect
      .poll(() => published[0])
      .toMatchObject({ catalogRead: 'unsupported', catalog: { origin: 'unknown' } })
  } finally {
    close()
  }
})
