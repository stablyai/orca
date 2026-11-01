import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type * as HostStructuredAgents from '@/runtime/host-structured-agents'
import type * as RouteInput from '@/lib/agent-launch-route-input'
import type * as ChatProgram from '@/lib/host-chat-program'
import type * as MenuRows from '@/lib/new-tab-agent-menu-rows'
import type * as ZustandShallow from 'zustand/react/shallow'
import type * as HostAgentSettingsTransport from '@/components/settings/agent-launch-settings-transport'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG
} from '../../../../shared/protocol-version'
type AgentMenuRowsMocks = {
  support: Mock
  subscribe: Mock
  publishing: boolean
  catalog: Mock
  failed: Mock
  load: Mock
  detection: Mock
  realRoutes: boolean
  realPublications: boolean
  catalogReads: number
  call: Mock
  routes: RouteInput.AgentLaunchRouteArgs[]
  answers: Parameters<typeof MenuRows.hostChatAnswer>[0][]
  selectors: number
  records: number
  lists: number
  metadata: number
  countedLists: WeakSet<object>
  program: Mock<
    (
      ...args: Parameters<typeof ChatProgram.readChatProgram>
    ) => ChatProgram.ChatProgramObservation | undefined
  >
}

const mocks: AgentMenuRowsMocks = vi.hoisted(() => ({
  support: vi.fn(),
  subscribe: vi.fn(),
  publishing: false,
  catalog: vi.fn(),
  failed: vi.fn(),
  load: vi.fn(),
  detection: vi.fn(),
  realRoutes: false,
  realPublications: false,
  catalogReads: 0,
  call: vi.fn(),
  routes: Array<RouteInput.AgentLaunchRouteArgs>(),
  answers: Array<Parameters<typeof MenuRows.hostChatAnswer>[0]>(),
  selectors: 0,
  records: 0,
  lists: 0,
  metadata: 0,
  countedLists: new WeakSet<object>(),
  program:
    vi.fn<
      (
        ...args: Parameters<typeof ChatProgram.readChatProgram>
      ) => ChatProgram.ChatProgramObservation | undefined
    >()
}))
vi.mock('zustand/react/shallow', async (importOriginal) => {
  const actual = await importOriginal<typeof ZustandShallow>()
  return {
    useShallow: <S, U>(selector: (state: S) => U) =>
      actual.useShallow((state: S) => {
        mocks.selectors++
        return selector(state)
      })
  }
})
vi.mock('@/lib/new-tab-agent-menu-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof MenuRows>()
  return {
    ...actual,
    buildNewTabAgentMenuRows: (...args: Parameters<typeof actual.buildNewTabAgentMenuRows>) => {
      const rows = actual.buildNewTabAgentMenuRows(...args)
      mocks.metadata += rows.length
      return rows
    },
    hostChatAnswer: (input: Parameters<typeof actual.hostChatAnswer>[0]) => {
      mocks.answers.push(input)
      if (mocks.realRoutes) {
        if (input.hostCapabilities) {
          counted(input.hostCapabilities)
        }
        if (input.hostStructuredAgents) {
          counted(input.hostStructuredAgents)
        }
      }
      return actual.hostChatAnswer(input)
    }
  }
})
vi.mock('@/components/settings/agent-launch-settings-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof HostAgentSettingsTransport>()
  return { ...actual, readHostAgentLaunchSettings: vi.fn().mockResolvedValue(null) }
})
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: mocks.subscribe }))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.support
}))
// Like the real hook: a closed menu acquires nothing, and the stored inventory stays.
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: mocks.detection
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => {
  const actual = await original<typeof RuntimeRpcClient>()
  return { ...actual, callRuntimeRpc: mocks.call }
})
vi.mock('@/runtime/host-structured-agents', async (original) => {
  const actual = await original<typeof HostStructuredAgents>()
  return {
    ...actual,
    readHostStructuredAgents: (...args: Parameters<typeof actual.readHostStructuredAgents>) => {
      mocks.catalogReads++
      return mocks.realPublications
        ? actual.readHostStructuredAgents(...args)
        : mocks.catalog(...args)
    },
    readHostStructuredAgentsForRuntime: (
      ...args: Parameters<typeof actual.readHostStructuredAgentsForRuntime>
    ) => {
      mocks.catalogReads++
      return mocks.realPublications
        ? actual.readHostStructuredAgentsForRuntime(...args)
        : mocks.catalog(...args)
    },
    hostStructuredAgentsReadFailed: (
      ...args: Parameters<typeof actual.hostStructuredAgentsReadFailed>
    ) =>
      mocks.realPublications
        ? actual.hostStructuredAgentsReadFailed(...args)
        : mocks.failed(...args),
    hostStructuredAgentsCatalogUnlearned: (
      ...args: Parameters<typeof actual.hostStructuredAgentsCatalogUnlearned>
    ) =>
      mocks.realPublications
        ? actual.hostStructuredAgentsCatalogUnlearned(...args)
        : args[1] !== undefined &&
          args[2]?.includes(CATALOG) === true &&
          !mocks.catalog(args[0], args[1]) &&
          !mocks.failed(args[0], args[1]),
    loadHostStructuredAgents: (...args: Parameters<typeof actual.loadHostStructuredAgents>) =>
      mocks.realPublications ? actual.loadHostStructuredAgents(...args) : mocks.load(...args),
    relearnHostStructuredAgents: (
      ...args: Parameters<typeof actual.relearnHostStructuredAgents>
    ) =>
      mocks.realPublications ? actual.relearnHostStructuredAgents(...args) : mocks.load(...args)
  }
})
vi.mock('@/lib/agent-launch-route-input', async (importOriginal) => {
  const actual = await importOriginal<typeof RouteInput>()
  return {
    ...actual,
    resolveAgentLaunchHost: (...args: Parameters<typeof actual.resolveAgentLaunchHost>) =>
      mocks.realRoutes
        ? actual.resolveAgentLaunchHost(...args)
        : {
            executionHostId: 'local',
            hostCapabilities:
              readLocalRuntimeCapabilitiesOrUnknown() === null
                ? null
                : [CHAT, CLIENT, CATALOG, ...(mocks.publishing ? [AVAILABILITY] : [])]
          },
    buildAgentLaunchRouteInput: (...args: Parameters<typeof actual.buildAgentLaunchRouteInput>) => {
      const [state, { agent }] = args
      if (mocks.realRoutes) {
        mocks.routes.push(args[1])
        return actual.buildAgentLaunchRouteInput(state, args[1])
      }
      return {
        agent,
        executionHostId: 'local',
        hostCapabilities:
          readLocalRuntimeCapabilitiesOrUnknown() === null
            ? null
            : [CHAT, CLIENT, CATALOG, ...(mocks.publishing ? [AVAILABILITY] : [])],
        clientCapabilities: [CHAT, CLIENT],
        hostStructuredAgents: ['claude', 'codex', 'opencode']
      }
    }
  }
})
vi.mock('@/lib/host-chat-program', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatProgram>()
  return {
    ...actual,
    readChatProgram: (...args: Parameters<typeof actual.readChatProgram>) =>
      mocks.program(...args) ?? actual.readChatProgram(...args)
  }
})
const actualRouteInput = await vi.importActual<typeof RouteInput>('@/lib/agent-launch-route-input')
const initial = useAppStore.getState()
beforeEach(() => {
  mocks.support.mockReset()
  mocks.subscribe.mockReset().mockResolvedValue({ unsubscribe: () => {} })
  mocks.publishing = false
  mocks.realRoutes = false
  mocks.realPublications = false
  mocks.catalogReads = 0
  mocks.call.mockReset()
  resetHostStructuredAgentsForTests()
  mocks.program.mockReset()
  mocks.catalog
    .mockReset()
    .mockReturnValue(['claude', 'codex', 'opencode'].map((agent) => ({ agent, capabilities: {} })))
  mocks.failed.mockReset().mockReturnValue(false)
  mocks.load.mockReset().mockResolvedValue(undefined)
  mocks.detection
    .mockReset()
    .mockReturnValue({ detectedIds: ['claude', 'codex', 'opencode', 'gemini'] })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, CATALOG])
  useAppStore.setState({
    ...initial,
    activeWorktreeId: 'one',
    settings: {
      ...getDefaultSettings('/home/me'),
      nativeChatProviders: { claude: true, codex: true },
      disabledTuiAgents: []
    },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    detectedAgentIds: ['claude', 'codex', 'opencode']
  })
})
afterEach(() => {
  cleanup()
  resetHostStructuredAgentsForTests()
})

function counted<T extends readonly unknown[]>(values: T): T {
  if (mocks.countedLists.has(values)) {
    return values
  }
  mocks.countedLists.add(values)
  values.forEach((value, index) =>
    Object.defineProperty(values, index, {
      get: () => {
        mocks.lists++
        return value
      }
    })
  )
  return values
}
function resetWork(): void {
  mocks.routes.length =
    mocks.answers.length =
    mocks.selectors =
    mocks.records =
    mocks.lists =
    mocks.metadata =
      0
  mocks.program.mockClear()
  mocks.catalog.mockClear()
}
function work() {
  return {
    routes: mocks.routes.length,
    selectors: mocks.selectors,
    records: mocks.records,
    answers: mocks.answers.length,
    programs: mocks.program.mock.calls.length,
    lists: mocks.lists,
    catalogs: mocks.catalog.mock.calls.length,
    metadata: mocks.metadata
  }
}

export { mocks, actualRouteInput, counted, resetWork, work }
