// @vitest-environment happy-dom

import { homedir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn(), cli: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-git-generation-client', () => ({
  discoverRuntimeCommitMessageModels: mocks.cli
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {},
  ensureLocalRuntimeCapabilities: async () => [],
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))

import { discoverNativeChatCatalogModels } from '../../src/renderer/src/components/native-chat/native-chat-session-option-discovery'
import type { AgentModelCatalogProbe } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-discovery'
import { createAgentModelCatalogService } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '../../src/renderer/src/runtime/host-model-catalog-snapshots'

const LOCAL = { kind: 'local' } as const
const NEW_CHAT = { newLaunch: true, worktree: 'wt-1', seedsModel: false }

function hostCatalog(agent: 'claude' | 'codex', store = new AgentModelCatalogStore()) {
  let held = false
  const entered = Promise.withResolvers<void>()
  const scope = Promise.withResolvers<void>()
  const resolveAccountHome = vi.fn(async () => ({
    variable: 'HOME',
    path: '/pr-36646-account'
  }))
  const listing = {
    origin: 'probe' as const,
    complete: true,
    configured: { model: 'account-model', effort: 'high' },
    models: [
      {
        id: 'account-model',
        label: 'Account model',
        isDefault: true,
        efforts: [{ value: 'high', label: 'High' }],
        defaultEffort: 'high',
        declaredDefaultEffort: 'high'
      }
    ]
  }
  const run = vi.fn(async () => listing)
  const probe = Object.assign(run, {
    resolve: vi.fn<NonNullable<AgentModelCatalogProbe['resolve']>>(async (_home, cwd) => {
      if (held) {
        entered.resolve()
        await scope.promise
      }
      return { identity: { command: agent, cwd }, run }
    })
  })
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome,
    probes: { [agent]: probe }
  })
  return {
    service,
    store,
    probe,
    listing,
    resolveAccountHome,
    entered,
    scope,
    hold: () => {
      held = true
    }
  }
}

describe('account catalog to renderer cache', () => {
  beforeEach(() => {
    resetHostModelCatalogSnapshotsForTests()
    mocks.call.mockReset()
    mocks.cli.mockReset()
  })

  it.each(['claude', 'codex'] as const)(
    'keeps %s provisional saved-only answers scoped while exact resolution is held',
    async (agent) => {
      const first = hostCatalog(agent)
      await first.service.read({ agent, waitForListing: true })
      expect(first.probe).toHaveBeenCalledTimes(1)
      first.service.stop()
      const { service, probe, resolveAccountHome, entered, scope, hold } = hostCatalog(
        agent,
        first.store
      )
      try {
        expect(service.snapshot({ agent })).toEqual({ origin: 'unknown' })
        hold()
        const refresh = service.demand({ agent })
        await entered.promise
        const resolutions = probe.resolve.mock.calls.length
        const homeResolutions = resolveAccountHome.mock.calls.length
        const publish = vi.spyOn(first.store, 'recordSuccess')
        const answers = [
          service.snapshot({ agent }),
          service.snapshot({ agent, savedOnly: true }),
          await service.read({ agent }),
          await service.read({ agent, savedOnly: true }),
          await service.prepareSaved({ agent })
        ]
        for (const answer of answers) {
          expect(answer).toMatchObject({
            modelsDifferByWorkspace: true,
            listingNamesConfiguredModel: false,
            models: [{ id: 'account-model', isDefault: false }]
          })
          if (answer.origin === 'unknown') {
            throw new Error('missing provisional inventory')
          }
          expect(answer.models[0]).not.toHaveProperty('defaultEffort')
          expect(answer.models[0]).not.toHaveProperty('declaredDefaultEffort')
          recordHostModelCatalogSnapshot(LOCAL, agent, null, answer)
          for (const newLaunch of [false, true]) {
            for (const seedsModel of [false, true]) {
              expect(
                readHostModelCatalogSnapshot(LOCAL, agent, {
                  newLaunch,
                  seedsModel,
                  worktree: 'restricted'
                })
              ).toBeUndefined()
            }
          }
        }
        expect(service.snapshot({ agent, verifiedOnly: true })).toEqual({ origin: 'unknown' })
        expect(await service.read({ agent, savedOnly: true, verifiedOnly: true })).toEqual({
          origin: 'unknown'
        })
        expect(probe.resolve).toHaveBeenCalledTimes(resolutions)
        expect(resolveAccountHome).toHaveBeenCalledTimes(homeResolutions)
        expect(probe).not.toHaveBeenCalled()
        expect(publish).not.toHaveBeenCalled()
        scope.resolve()
        await refresh
        expect(probe.resolve.mock.calls.every(([, cwd]) => cwd === homedir())).toBe(true)
        const exact = service.snapshot({ agent, verifiedOnly: true })
        expect(exact).toMatchObject({
          models: [{ id: 'account-model', isDefault: true, declaredDefaultEffort: 'high' }]
        })
        recordHostModelCatalogSnapshot(LOCAL, agent, 'own-folder', exact)
        expect(
          readHostModelCatalogSnapshot(LOCAL, agent, { ...NEW_CHAT, worktree: 'own-folder' })
        ).toEqual(exact)
        expect(
          readHostModelCatalogSnapshot(LOCAL, agent, { ...NEW_CHAT, worktree: 'restricted' })
        ).toBeUndefined()
      } finally {
        scope.resolve()
        service.stop()
      }
    }
  )

  it.each(['claude', 'codex'] as const)(
    'terminal discovery consumes the real %s accepted response after a failed refresh',
    async (agent) => {
      const h = hostCatalog(agent)
      h.listing.models.push({
        ...h.listing.models[0],
        id: 'other-model',
        label: 'Other',
        isDefault: false
      })
      try {
        await h.service.demand({ agent })
        h.probe.resolve.mockRejectedValue(new Error('scope lookup failed'))
        await h.service.demand({ agent })
        mocks.call.mockImplementation((_target, _method, params: { agent: string }) =>
          h.service.read(params)
        )
        const models = await discoverNativeChatCatalogModels(
          agent,
          { target: LOCAL, worktreeId: null, worktreePath: '' },
          'local'
        )
        expect(mocks.call).toHaveBeenCalledWith(LOCAL, 'agentSession.modelCatalog', { agent })
        expect(
          models?.map(({ id, label, isDefault }) => ({ id, label, isDefault: !!isDefault }))
        ).toEqual([
          { id: 'account-model', label: 'Account model', isDefault: true },
          { id: 'other-model', label: 'Other', isDefault: false }
        ])
        expect(mocks.cli).not.toHaveBeenCalled()
      } finally {
        h.service.stop()
      }
    }
  )
})
