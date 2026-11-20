// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch/choices/agent-launch-settings'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearHostAgentMenuSettingsForTests } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import {
  AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { BotAgentSettings } from '../settings/bots/BotGeneralSettings'

const mocks = vi.hoisted(() => {
  const calls: { target: RuntimeClientTarget; method: string; params: unknown }[] = []
  return {
    calls,
    rpcImpl: vi.fn()
  }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (target: RuntimeClientTarget, method: string, params: unknown) => {
    mocks.calls.push({ target, method, params })
    return mocks.rpcImpl(target, method, params)
  }
}))

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))

const CAPABILITIES = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]

const LIVE_CODEX_CATALOG = {
  origin: 'probe' as const,
  fetchedAt: 1,
  listingNamesConfiguredModel: true,
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isDefault: true, efforts: [] },
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', isDefault: false, efforts: [] }
  ]
}

function remoteStatus(runtimeId = 'runtime-1'): RuntimeEnvironmentStatus {
  return {
    status: {
      runtimeId,
      capabilities: CAPABILITIES,
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    },
    checkedAt: 1
  }
}

function makeBot(overrides: Partial<Bot> = {}, hostId: ExecutionHostId = 'local'): Bot {
  return stampBotHost(hostId, {
    id: 'bot-1',
    name: 'Scout',
    hostId: 'local',
    folder: 'scout',
    folderWorkspaceId: 'fw-1',
    agent: 'codex',
    avatar: mascotAvatar('B1'),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  })
}

async function openPickerTrigger(): Promise<void> {
  const trigger = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-agent-launch-picker-trigger]')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)
    return button!
  })
  fireEvent.pointerDown(trigger, { button: 0 })
  await waitFor(() => {
    expect(document.querySelector('[data-agent-launch-picker]')).not.toBeNull()
  })
}

describe('BotAgentSettings live model catalog', () => {
  const previous = useAppStore.getState()

  beforeEach(() => {
    mocks.calls.length = 0
    mocks.rpcImpl.mockReset()
    clearHostAgentMenuSettingsForTests()
    clearRuntimeCompatibilityCache()
    resetHostStructuredAgentsForTests()
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 7 }])
    setLocalRuntimeCapabilitiesForTests(CAPABILITIES)
    useAppStore.setState({
      ...previous,
      settings: {
        ...getDefaultSettings('/synthetic'),
        nativeChatProviders: {}
      },
      runtimeStatusByEnvironmentId: new Map([['env-1', remoteStatus()]]),
      detectedAgentIds: ['claude', 'codex'],
      isDetectingAgents: false,
      ensureDetectedAgents: async () => ['claude', 'codex'],
      runtimeDetectedAgentIds: { 'env-1': ['claude', 'codex'] },
      isDetectingRuntimeAgents: { 'env-1': false },
      ensureRuntimeDetectedAgents: async () => ['claude', 'codex'],
      refreshRuntimeDetectedAgents: async () => ['claude', 'codex']
    })
  })

  afterEach(() => {
    cleanup()
    clearHostAgentMenuSettingsForTests()
    clearRuntimeCompatibilityCache()
    resetHostStructuredAgentsForTests()
    replaceRuntimeEnvironmentRevisions([])
    setLocalRuntimeCapabilitiesForTests(null)
    useAppStore.setState(previous, true)
  })

  it('lists live Codex models from a paired bot host instead of falling back to local static models', async () => {
    mocks.rpcImpl.mockImplementation(
      async (target: RuntimeClientTarget, method: string, params: Record<string, unknown>) => {
        if (method === 'agentSession.agents') {
          return {
            agents: [
              { agent: 'claude', label: 'Claude' },
              { agent: 'codex', label: 'Codex' }
            ]
          }
        }
        if (method === 'agentLaunchSettings.get') {
          return { settings: projectAgentLaunchSettings({}) }
        }
        if (method === 'agentSession.modelCatalog') {
          return target.kind === 'environment' &&
            target.environmentId === 'env-1' &&
            params?.agent === 'codex'
            ? LIVE_CODEX_CATALOG
            : { origin: 'unknown' }
        }
        return {}
      }
    )

    render(
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <BotAgentSettings
            bot={makeBot({ folderWorkspaceId: 'fw-remote' }, 'runtime:env-1')}
            update={async () => null}
          />
        </ConfirmationDialogProvider>
      </TooltipProvider>
    )

    await openPickerTrigger()

    await waitFor(() => {
      expect(screen.queryByText('GPT-6.1 Sol')).not.toBeNull()
      expect(screen.queryByText('GPT-6.2 Sol')).not.toBeNull()
    })
    expect(screen.queryByText('GPT-5.6 Sol')).toBeNull()
    expect(mocks.calls).toContainEqual({
      target: { kind: 'environment', environmentId: 'env-1' },
      method: 'agentSession.modelCatalog',
      params: { agent: 'codex', worktree: 'id:folder:fw-remote' }
    })
  })

  it('scopes bot settings model catalog reads to the bot home folder workspace', async () => {
    mocks.rpcImpl.mockImplementation(
      async (_target: RuntimeClientTarget, method: string, params: Record<string, unknown>) => {
        if (method === 'agentSession.agents') {
          return {
            agents: [
              { agent: 'claude', label: 'Claude' },
              { agent: 'codex', label: 'Codex' }
            ]
          }
        }
        if (method === 'agentSession.modelCatalog') {
          return params?.agent === 'codex' && params?.worktree === 'id:folder:fw-1'
            ? LIVE_CODEX_CATALOG
            : { origin: 'unknown' }
        }
        return {}
      }
    )

    render(
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <BotAgentSettings
            bot={makeBot({ hostId: 'local', folderWorkspaceId: 'fw-1' })}
            update={async () => null}
          />
        </ConfirmationDialogProvider>
      </TooltipProvider>
    )

    await openPickerTrigger()

    await waitFor(() => {
      expect(screen.queryByText('GPT-6.1 Sol')).not.toBeNull()
    })
    expect(screen.queryByText('GPT-5.6 Sol')).toBeNull()
    expect(mocks.calls).toContainEqual({
      target: { kind: 'local' },
      method: 'agentSession.modelCatalog',
      params: { agent: 'codex', worktree: 'id:folder:fw-1' }
    })
  })
})
