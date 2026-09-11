/**
 * Capability evidence must belong to the machine that would run the session.
 *
 * The route builder used to fill `hostCapabilities` from this client's own cache for every target,
 * so a remote launch would be admitted or refused on facts about the wrong machine. Each row
 * asserts both halves: the evidence the builder captured, and what the route then decides — with
 * the remote-create switch off, which is what a fresh install has, and with it on.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  resolveStructuredNativeChatSupport,
  structuredNativeChatRemoteCreateEnabled,
  type StructuredNativeChatBlocker,
  type StructuredNativeChatHostStatusBlocker,
  type StructuredNativeChatSupport
} from '../../../shared/structured-native-chat-launch-route'
import type { RuntimeEnvironmentStatus } from '@/store/slices/runtime-status-types'
import { STRUCTURED_CHAT_HOST_VERDICT_STALE_MS } from '@/runtime/structured-chat-host-verdict'
import type * as ConnectionOwnerResolutionModule from './connection-owner-resolution'

const mocks = vi.hoisted(() => ({
  getExecutionHostIdForWorktree: vi.fn(),
  getConnectionIdFromState: vi.fn(),
  getLocalProjectExecutionRuntimeContext: vi.fn(),
  getLocalRepoProjectExecutionRuntimeContext: vi.fn(),
  readLocalRuntimeCapabilitiesOrUnknown: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: mocks.getExecutionHostIdForWorktree
}))
vi.mock('@/lib/connection-owner-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionOwnerResolutionModule>()),
  getConnectionIdFromState: mocks.getConnectionIdFromState
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: mocks.getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext: mocks.getLocalRepoProjectExecutionRuntimeContext
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: mocks.readLocalRuntimeCapabilitiesOrUnknown
}))

import {
  structuredAgentLaunchSupported,
  type AgentLaunchRoutingInput
} from './agent-launch-routing'
import {
  buildAgentLaunchRouteInput,
  type AgentLaunchRouteStore,
  type ProspectiveWorkspace
} from './agent-launch-route-input'

const NOW = 1_700_000_000_000
const ENVIRONMENT_ID = 'env a'
const REMOTE_HOST_ID = 'runtime:env%20a'
// Distinct from every paired list below, so a row that answers with this one is reading the
// local cache rather than the target host.
const LOCAL_CAPABILITIES = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
const PAIRED_CAPABILITIES = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AI_VAULT_RUNTIME_CAPABILITY
]
const PAIRED_WITHOUT_STRUCTURED = [AI_VAULT_RUNTIME_CAPABILITY]

const SUPPORTED: StructuredNativeChatSupport = { supported: true }
const refused = (blocker: StructuredNativeChatBlocker): StructuredNativeChatSupport => ({
  supported: false,
  blocker
})

/** A host publishes its effective admission next to its capabilities; an older one publishes none. */
function hostStatus(
  capabilities: readonly string[],
  admission?: { enabled: boolean }
): RuntimeStatus {
  return {
    runtimeId: 'rt-1',
    capabilities: [...capabilities],
    ...(admission ? { structuredSessionAdmission: admission } : {})
  } as unknown as RuntimeStatus
}

function entry(
  patch: Partial<RuntimeHostStatusSnapshot> & { status?: RuntimeStatus | null }
): RuntimeEnvironmentStatus {
  const snapshot: RuntimeHostStatusSnapshot = {
    environmentId: ENVIRONMENT_ID,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: NOW,
    transport: 'ready',
    verification: 'verified',
    status: hostStatus(PAIRED_CAPABILITIES),
    ...patch
  }
  return { snapshot, status: snapshot.status, checkedAt: snapshot.checkedAt }
}

const REMOTE_WORKSPACE: ProspectiveWorkspace = {
  kind: 'git-worktree',
  repoId: 'repo-1',
  executionHostId: REMOTE_HOST_ID
}

type Row = {
  label: string
  workspace: ProspectiveWorkspace
  entry?: RuntimeEnvironmentStatus
  hostCapabilities: readonly string[] | null
  hostStatusBlocker?: StructuredNativeChatHostStatusBlocker
  /** What this evidence alone decides, once `remote-execution-host` no longer fires first. */
  onEvidence: StructuredNativeChatSupport
}

const ROWS: Row[] = [
  {
    label: 'a local target',
    workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
    hostCapabilities: LOCAL_CAPABILITIES,
    onEvidence: SUPPORTED
  },
  {
    label: 'a paired host that advertises structured chat',
    workspace: REMOTE_WORKSPACE,
    entry: entry({}),
    hostCapabilities: PAIRED_CAPABILITIES,
    onEvidence: SUPPORTED
  },
  {
    label: 'a paired host that never advertised it',
    workspace: REMOTE_WORKSPACE,
    entry: entry({ status: hostStatus(PAIRED_WITHOUT_STRUCTURED) }),
    hostCapabilities: PAIRED_WITHOUT_STRUCTURED,
    onEvidence: refused('runtime-capability')
  },
  {
    label: 'a paired host with structured chat switched off',
    workspace: REMOTE_WORKSPACE,
    entry: entry({ status: hostStatus(PAIRED_CAPABILITIES, { enabled: false }) }),
    hostCapabilities: PAIRED_CAPABILITIES,
    hostStatusBlocker: 'host-policy-disabled',
    onEvidence: refused('host-policy-disabled')
  },
  {
    label: 'a paired host that has not answered',
    workspace: REMOTE_WORKSPACE,
    entry: entry({ verification: 'unavailable', status: null }),
    hostCapabilities: null,
    onEvidence: refused('runtime-capability-unknown')
  },
  {
    label: 'a host this client disconnected',
    workspace: REMOTE_WORKSPACE,
    entry: entry({ retired: true, transport: 'disconnected', verification: 'blocked' }),
    hostCapabilities: null,
    hostStatusBlocker: 'host-disconnected',
    onEvidence: refused('host-disconnected')
  },
  {
    label: 'a re-paired host whose entry has not landed again',
    workspace: REMOTE_WORKSPACE,
    hostCapabilities: null,
    onEvidence: refused('runtime-capability-unknown')
  },
  {
    label: 'a direct SSH target, which publishes no host status',
    workspace: { kind: 'git-worktree', repoId: 'repo-1', executionHostId: 'ssh:build-box' },
    entry: entry({}),
    hostCapabilities: null,
    onEvidence: refused('runtime-capability-unknown')
  },
  {
    label: 'a folder workspace on a paired host',
    workspace: { kind: 'folder', runtimeEnvironmentId: ENVIRONMENT_ID },
    entry: entry({}),
    hostCapabilities: PAIRED_CAPABILITIES,
    onEvidence: SUPPORTED
  }
]

/** Deliberately built WITHOUT `structuredChatRemoteCreate` unless a row asks: the field a fresh
 *  install has never written is the one the default has to be read from. */
function store(row: Row, remoteCreate = false): AgentLaunchRouteStore {
  return {
    settings: {
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      experimentalStructuredNativeChat: true,
      ...(remoteCreate ? { structuredChatRemoteCreate: true } : {})
    },
    runtimeStatusByEnvironmentId: row.entry
      ? new Map([[ENVIRONMENT_ID, row.entry]])
      : new Map<string, RuntimeEnvironmentStatus>()
  } as unknown as AgentLaunchRouteStore
}

/** The route as the renderer asks it: the switch is read off the store's settings, never handed in.
 *  `structuredAgentLaunchSupported` below is the production wiring; this only names the blocker. */
function routeAnswer(input: AgentLaunchRoutingInput): StructuredNativeChatSupport {
  return resolveStructuredNativeChatSupport({
    ...input,
    remoteCreateEnabled: structuredNativeChatRemoteCreateEnabled(input.settings)
  })
}

function isSshTarget(executionHostId: string): boolean {
  return executionHostId.startsWith('ssh:')
}

/** What a user who has never touched the switch gets. */
function switchedOffAnswer(row: Row): StructuredNativeChatSupport {
  if (row.workspace.worktreeId) {
    return SUPPORTED
  }
  return isSshTarget(row.workspace.executionHostId ?? '')
    ? refused('remote-execution-host')
    : refused('remote-create-disabled')
}

describe('launch capability evidence per execution host', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
    mocks.getExecutionHostIdForWorktree.mockReturnValue('local')
    mocks.getConnectionIdFromState.mockReturnValue(null)
    mocks.getLocalProjectExecutionRuntimeContext.mockReturnValue(undefined)
    mocks.getLocalRepoProjectExecutionRuntimeContext.mockReturnValue(undefined)
    mocks.readLocalRuntimeCapabilitiesOrUnknown.mockReturnValue(LOCAL_CAPABILITIES)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(ROWS)('captures the evidence of $label', (row) => {
    const input = buildAgentLaunchRouteInput(store(row), {
      agent: 'claude',
      workspace: row.workspace
    })
    expect(input.hostCapabilities).toEqual(row.hostCapabilities)
    expect(input.hostStatusBlocker).toBe(row.hostStatusBlocker)
    // The evidence alone, with the host question settled, decides the answer.
    expect(resolveStructuredNativeChatSupport({ ...input, executionHostId: 'local' })).toEqual(
      row.onEvidence
    )
    // ...and with the switch off — a fresh install — a paired host is refused before any of it is
    // read, while SSH is refused for the reason that never changes.
    expect(routeAnswer(input)).toEqual(switchedOffAnswer(row))
    expect(structuredAgentLaunchSupported(input)).toBe(input.executionHostId === 'local')
  })

  it.each(ROWS)('admits $label only as far as its own evidence once the switch is on', (row) => {
    const input = buildAgentLaunchRouteInput(store(row, true), {
      agent: 'claude',
      workspace: row.workspace
    })
    // SSH has no client RPC path to a structured session, so the switch never reaches it.
    expect(routeAnswer(input)).toEqual(
      isSshTarget(input.executionHostId) ? refused('remote-execution-host') : row.onEvidence
    )
    expect(structuredAgentLaunchSupported(input)).toBe(
      !isSshTarget(input.executionHostId) && row.onEvidence.supported
    )
  })

  function remoteInput(host: RuntimeEnvironmentStatus) {
    return buildAgentLaunchRouteInput(
      store({ label: '', workspace: REMOTE_WORKSPACE, entry: host } as Row),
      { agent: 'claude', workspace: REMOTE_WORKSPACE }
    )
  }

  it('never reads a host that answered too long ago as a refusal', () => {
    const input = remoteInput(
      entry({
        checkedAt: NOW - STRUCTURED_CHAT_HOST_VERDICT_STALE_MS - 1,
        status: hostStatus(PAIRED_WITHOUT_STRUCTURED)
      })
    )
    expect(input.hostCapabilities).toBeNull()
    expect(input.hostStatusBlocker).toBeUndefined()
  })

  it('reads a host that publishes no admission as unknown policy, never as disabled', () => {
    const older = entry({ status: hostStatus(PAIRED_CAPABILITIES) })
    expect(older.snapshot?.status).not.toHaveProperty('structuredSessionAdmission')
    const input = remoteInput(older)
    expect(input.hostCapabilities).toEqual(PAIRED_CAPABILITIES)
    expect(input.hostStatusBlocker).toBeUndefined()
    expect(resolveStructuredNativeChatSupport({ ...input, executionHostId: 'local' })).toEqual(
      SUPPORTED
    )
  })

  it('never consults this client for a remote target', () => {
    remoteInput(entry({}))
    expect(mocks.readLocalRuntimeCapabilitiesOrUnknown).not.toHaveBeenCalled()
  })
})
