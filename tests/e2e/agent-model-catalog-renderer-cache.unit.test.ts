// @vitest-environment happy-dom

import { homedir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {},
  ensureLocalRuntimeCapabilities: async () => [],
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))

import { createAgentModelCatalogService } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '../../src/renderer/src/runtime/host-model-catalog-snapshots'

const LOCAL = { kind: 'local' } as const
const NEW_CHAT = { newLaunch: true, worktree: 'wt-1', seedsModel: false }

describe('account catalog to renderer cache', () => {
  beforeEach(() => {
    resetHostModelCatalogSnapshotsForTests()
  })

  it.each(['claude', 'codex'] as const)(
    'keeps %s provisional saved-only answers scoped while exact resolution is held',
    async (agent) => {
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
        resolve: vi.fn(async (_home: unknown, cwd: string) => {
          if (held) {
            entered.resolve()
            await scope.promise
          }
          return { identity: { command: agent, cwd }, run }
        })
      })
      const service = createAgentModelCatalogService({
        store: new AgentModelCatalogStore(),
        getConversation: () => undefined,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome,
        probes: { [agent]: probe }
      })
      try {
        await service.read({ agent, waitForListing: true })
        expect(probe).toHaveBeenCalledTimes(1)
        held = true
        const refresh = service.demand({ agent })
        await entered.promise
        const resolutions = probe.resolve.mock.calls.length
        const homeResolutions = resolveAccountHome.mock.calls.length
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
        expect(probe).toHaveBeenCalledTimes(1)
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
})
