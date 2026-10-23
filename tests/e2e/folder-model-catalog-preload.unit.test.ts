// @vitest-environment happy-dom

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentModelCatalogFingerprint } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogFilePersistence } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-persistence'
import { PI_RPC_RUNTIME_METADATA } from '../../src/main/pi/rpc-runtime-metadata'
import { acpLaunchSpecFor, acpListingNeedsChatFolder } from '../../src/main/acp/acp-launch-specs'
import { firstFrameOptionState } from '../../src/renderer/src/components/native-chat/use-structured-agent-session-option-state'
import { applyStructuredAgentSessionModelCatalog } from '../../src/shared/structured-agent-session-options'
import { structuredAgentSessionSeedCatalog } from '../../src/shared/structured-agent-session-seed-catalog'
import * as snapshots from '@/runtime/host-model-catalog-snapshots'
import { installHostModelCatalogSnapshotsSync } from '@/runtime/host-model-catalog-snapshots-sync'

const mocks = vi.hoisted(() => ({ call: vi.fn(), agent: 'pi' }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/local-structured-chats', () => ({ localStructuredChatsInUse: async () => true }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {},
  ensureLocalRuntimeCapabilities: async () => ['agent-session.model-catalog.saved-only.v1']
}))
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgentsForRuntime: () => [{ agent: mocks.agent }],
  subscribeHostStructuredAgents: () => () => {}
}))

it.each([
  ['pi', true],
  ['opencode2', true],
  ['grok', false]
] as const)(
  '%s upgrade preload preserves account rows without borrowing folder-sensitive inventory',
  async (agent, expectedFolderScope) => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-rpc-inventory-preload-'))
    let stop = () => {}
    try {
      mocks.agent = agent
      mocks.call.mockReset()
      snapshots.resetHostModelCatalogSnapshotsForTests()
      const unused = async (): Promise<never> => {
        throw new Error('no probe during registration')
      }
      const piDiscovery = PI_RPC_RUNTIME_METADATA.modelCatalog({
        deps: {
          stateDirectory: directory,
          hostId: 'local',
          claimKeyId: 'preload',
          resolveWorkspacePath: unused,
          resolveLaunchArgs: () => [],
          resolveClaudeAuthPolicy: () => ({ account: 'system' }),
          logger: { warn: vi.fn(), error: vi.fn() }
        },
        environment: {
          resolveBaseEnvironment: unused,
          resolveAgentEnvironment: unused,
          refreshAfterMissingProgram: unused
        }
      })
      const folderScoped =
        agent === 'pi'
          ? piDiscovery.kind === 'probe' && piDiscovery.listsInChatFolder === true
          : acpListingNeedsChatFolder(acpLaunchSpecFor(agent)!.modelDiscovery)
      expect(folderScoped).toBe(expectedFolderScope)
      const variable = { pi: 'PI_CODING_AGENT_DIR', opencode2: 'OPENCODE_HOME', grok: 'GROK_HOME' }[
        agent
      ]
      const accountHome = { variable, path: '/account/a' }
      const key = agentModelCatalogFingerprint({ agent, accountHome, wslDistro: null })
      const persistence = createAgentModelCatalogFilePersistence(directory)
      const previous = new AgentModelCatalogStore()
      const efforts = [{ value: 'high', label: 'High' }]
      const models = [{ id: 'provider/old', label: 'Old', isDefault: false, efforts }]
      previous.recordSuccess(key, agent, { origin: 'probe', models }, 'discovery')
      const entry = previous.get(key)!
      await writeFile(
        join(directory, 'agent-model-catalog.json'),
        JSON.stringify({
          version: 3,
          entries: [{ agent, fingerprint: key, discovered: entry.discovered, live: entry.live }]
        })
      )
      const store = new AgentModelCatalogStore()
      await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
      const oldEntry = store.get(key)
      const probe = vi.fn(async () => {
        throw new Error('folder B discovery failed')
      })
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => accountHome,
        listsInChatFolder: new Set(folderScoped ? [agent] : []),
        probes: { [agent]: probe }
      })
      mocks.call.mockImplementation((_target, _method, params) => service.read(params))
      stop = installHostModelCatalogSnapshotsSync()
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
      await mocks.call.mock.results[0]!.value
      const account = await service.read({ agent, savedOnly: true })
      if (account.origin === 'unknown') {
        throw new Error('saved account inventory missing')
      }
      expect(account.models[0]?.id).toBe('provider/old')
      expect(mocks.call.mock.calls[0]).toEqual([
        { kind: 'local' },
        'agentSession.modelCatalog',
        { agent, savedOnly: true }
      ])
      expect(probe).not.toHaveBeenCalled()
      const target = { kind: 'local' } as const
      const launch = { newLaunch: true, worktree: 'folder-b', seedsModel: true }
      let frame = firstFrameOptionState(agent, target, launch)
      frame.record.values = {
        model: { value: 'provider/saved-literal', source: 'applied' },
        effort: { value: 'high', source: 'applied' }
      }
      const saved = structuredClone(frame.record.values)
      const ids = () => frame.catalog?.models.map((model) => model.id) ?? []
      expect(ids().includes('provider/old')).toBe(!expectedFolderScope)
      const failed = await service.read({ agent, workspacePath: '/work/b', waitForListing: true })
      if (expectedFolderScope) {
        expect(failed.origin).toBe('unknown')
      }
      snapshots.recordHostModelCatalogSnapshot(target, agent, launch.worktree, failed)
      frame = applyStructuredAgentSessionModelCatalog(
        frame,
        structuredAgentSessionSeedCatalog(agent),
        failed,
        launch
      )
      expect(ids().includes('provider/old')).toBe(!expectedFolderScope)
      expect(frame.record.values).toEqual(saved)
      expect(await service.read({ agent, savedOnly: true })).toEqual(account)
      expect(store.get(key)).toEqual(oldEntry)
      expect((await persistence.load())[0]).toEqual(oldEntry)
      const { modelsDifferByWorkspace, ...oldHost } = account
      expect(modelsDifferByWorkspace).toBe(expectedFolderScope ? true : undefined)
      snapshots.recordHostModelCatalogSnapshot(target, agent, null, oldHost)
      expect(firstFrameOptionState(agent, target, launch).catalog?.models[0]?.id).toBe(
        'provider/old'
      )
      service.stop()
    } finally {
      stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
