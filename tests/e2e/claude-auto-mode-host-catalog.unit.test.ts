// @vitest-environment happy-dom
// A new Claude chat offers Approve for me from the host's real catalog: the background listing, its
// saved file, the host's reads and the renderer's hook, with only the CLI's answer stood in.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() })),
  callStructuredAgentSession: mocks.rpc
}))
vi.mock(
  '../../src/renderer/src/components/native-chat/native-chat-session-option-settings-write',
  () => ({
    enqueueSessionOptionSettingsWrite: vi.fn()
  })
)
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import { agentSessionRecordFixture } from '../../src/main/native-chat/agent-session-record-test-fixture'
import type { SessionOptionDescriptor } from '../../src/shared/native-chat-session-options'
import { createClaudeModelCatalogProbe } from '../../src/main/claude/claude-model-catalog-probe'
import { createAgentModelCatalogFilePersistence } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-persistence'
import { createAgentModelCatalogService } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import { workspaceMayOverrideDefaultModel } from '../../src/main/native-chat/agent-model-catalog/agent-project-model-override'
import { claudeAndCodexDeclared } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionMutationContext } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-mutations'
import {
  IN_PROCESS_OPTIONS_READER,
  readStructuredAgentSessionOptions
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-options-read'
import { resolveStructuredAgentCommand } from '../../src/main/native-chat/structured-agent-command-resolution'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { useStructuredAgentSessionOptions } from '../../src/renderer/src/components/native-chat/use-structured-agent-session-options'

const SESSION = 'claude-session-1'
const LOCAL_TARGET = { kind: 'local' } as const
const LAUNCH = {
  kind: 'new',
  heldOptions: {},
  worktree: 'id:workspace-1',
  seedOptions: { permissionMode: 'ask' }
} as const
const mutate = vi.fn()

// What `claude` 2.1.280 answers `list_models` with, reduced to the fields the catalog reads.
const LISTING = `${JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'orca-model-discovery',
    response: {
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', supportsAutoMode: true },
        {
          value: 'opus[1m]',
          displayName: 'Opus (1M context)',
          resolvedModel: 'claude-opus-5-5[1m]',
          supportsAutoMode: true
        },
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          resolvedModel: 'claude-sonnet-5',
          supportsAutoMode: true
        },
        {
          value: 'haiku',
          displayName: 'Haiku',
          resolvedModel: 'claude-haiku-4-5-20251001',
          supportsAutoMode: null
        }
      ]
    }
  }
})}\n${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'orca-model-settings', response: { applied: { model: 'claude-opus-5-5[1m]' } } } })}\n`

let dir: string
let release: () => void

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-host-auto-mode-'))
  mocks.rpc.mockReset()
  resetHostModelCatalogSnapshotsForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The host's catalog over its saved file, listing through the real Claude probe. */
async function hostCatalog(listingLands: Promise<void>) {
  const store = new AgentModelCatalogStore()
  const persistence = createAgentModelCatalogFilePersistence(join(dir, 'state'))
  await store.attachPersistence(persistence)
  const record = agentSessionRecordFixture({
    sessionId: SESSION,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(dir, 'claude-home') },
    providerHandleChain: [],
    options: { permissionMode: 'ask' }
  })
  const modelCatalog = createAgentModelCatalogService({
    store,
    getRecord: () => record,
    drivesRecord: () => true,
    resolveAccountHome: async () => record.accountHome,
    recordWorkspacePath: async () => join(dir, 'project'),
    workspaceMayOverrideDefaultModel,
    probes: {
      claude: createClaudeModelCatalogProbe({
        resolveCommand: () =>
          resolveStructuredAgentCommand('claude', {
            agentCmdOverrides: { claude: `"${process.execPath}"` }
          }),
        resolveEnv: () => ({}),
        resolveInheritedEnv: async () => ({ PATH: '/resolved/bin' }),
        resolveAuthPolicy: () => ({ account: 'system' }),
        runListing: async () => {
          await listingLands
          return LISTING
        }
      })
    }
  })
  const resting = {
    child: null,
    params: { provider: 'claude' },
    journal: {
      threadGoal: () => null,
      visitItems: () => {},
      submissions: () => [],
      contextUsage: () => null,
      context: { floor: () => null }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
  const context = {
    deps: {
      adapter: {},
      agents: claudeAndCodexDeclared(),
      store: { getRecord: () => record },
      modelCatalog
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  // As the host's RPC methods answer them: the catalog for the chat's folder, and its options.
  mocks.rpc.mockImplementation(
    (_target: unknown, method: string, params: { waitForListing?: boolean }) =>
      method === 'agentSession.modelCatalog'
        ? modelCatalog.read({
            agent: 'claude',
            sessionId: SESSION,
            workspacePath: join(dir, 'project'),
            ...(params.waitForListing ? { waitForListing: true } : {})
          })
        : method === 'agentSession.options'
          ? readStructuredAgentSessionOptions(context, SESSION, IN_PROCESS_OPTIONS_READER)
          : new Promise(() => {})
  )
  return { persistence }
}

function offered(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const entry = snapshot.find((descriptor) => descriptor.id === 'permissionMode')
  return entry?.kind.type === 'select' ? entry.kind.choices.map((choice) => choice.value) : []
}

function openNewChat() {
  return renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'claude',
      sessionId: SESSION,
      target: LOCAL_TARGET,
      transportEnabled: true,
      isVisible: true,
      providerVisible: true,
      fence: 1,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate,
      launch: LAUNCH
    })
  )
}

const optionReads = () =>
  mocks.rpc.mock.calls.filter(([, method]) => method === 'agentSession.options').length

describe('Approve for me on a new Claude chat', () => {
  it('is offered once the background listing lands after the chat opened', async () => {
    const lands = new Promise<void>((resolve) => (release = resolve))
    await hostCatalog(lands)
    const { result, unmount } = openNewChat()
    // The chat opened before its account was ever listed: the first answers come without a list.
    await waitFor(() => expect(optionReads()).toBe(1))
    await waitFor(() => expect(offered(result.current.optionSnapshot)).toContain('ask'))
    expect(offered(result.current.optionSnapshot)).not.toContain('auto')

    release()
    await waitFor(() => expect(offered(result.current.optionSnapshot)).toContain('auto'))
    unmount()
  })

  it('is offered from the catalog the background listing saved before the chat opened', async () => {
    const first = await hostCatalog(Promise.resolve())
    await mocks.rpc(undefined, 'agentSession.modelCatalog', { waitForListing: true })
    await first.persistence.flush()
    // A restarted host retains the rows and revalidates its configured default before naming it.
    await hostCatalog(Promise.resolve())
    const { result, unmount } = openNewChat()
    await waitFor(() => expect(offered(result.current.optionSnapshot)).toContain('auto'))
    unmount()
  })
})
