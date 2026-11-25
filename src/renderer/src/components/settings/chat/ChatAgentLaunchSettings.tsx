import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { useEffect } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { cn } from '@/lib/class-names'
import {
  chatProviderAgents,
  managedRuntimeChatAgents,
  useHostStructuredAgentsVersion
} from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { recomputeOn } from '@/lib/recompute-on'
import {
  readChatProgram,
  resolveChatProgramContext
} from '@/lib/agent-session/launch/inventory/host-chat-program'
import { useChatProgramFacts } from '@/lib/agent-session/launch/inventory/host-chat-program-acquisition'
import { useAppStore } from '@/store/index'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { agentLaunchRouteStoreFor } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { readNativeDetectedAgents } from '@/store/slices/agent-inventory/local-detected-agent-store-state'
import {
  AgentOpensAsControl,
  chatUnavailableOnThisDesktop,
  useAgentChatRuntimeInstall
} from '../../agent/launch-settings/AgentChatChoiceControls'
import {
  buildAgentOpensAs,
  type AgentOpensAs
} from '../../../lib/agent-session/launch/native-chat-provider-choice'
import { ManagedRuntimeInstallRow } from '../../managed-runtime/ManagedRuntimeInstallRow'
import { managedRuntimeInstallPending } from '../../managed-runtime/managed-runtime-install-view'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { getChatLaunchEntriesByKey } from './chat-launch-search'
import { useTranslate } from '@/i18n/use-translate'

const WORKSPACE = { kind: 'floating' } as const

export function ChatAgentLaunchSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const hostAgentsVersion = useHostStructuredAgentsVersion()
  useChatProgramFacts(WORKSPACE)
  useEffect(() => {
    void useAppStore.getState().ensureNativeDetectedAgents()
  }, [])
  const detected = useAppStore(readNativeDetectedAgents)
  const chatOnlyKey = useAppStoreWithHostStatuses((appState, statuses) => {
    const state = agentLaunchRouteStoreFor(appState, statuses)
    const context = resolveChatProgramContext(state, WORKSPACE)
    return chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
      .filter(
        (agent) =>
          !detected?.includes(agent) &&
          readChatProgram(statuses, agent, context, detected) === 'available'
      )
      .join(' ')
  })
  const chatOnly = new Set(chatOnlyKey.split(' '))
  const managedChatAgents = recomputeOn([hostAgentsVersion], () =>
    managedRuntimeChatAgents(LOCAL_EXECUTION_HOST_ID, undefined)
  )
  const entry = getChatLaunchEntriesByKey(t).agents
  return (
    <SettingsGroup title={entry.title} description={entry.description}>
      {getAgentCatalog().map((agent) => {
        const opensAs = recomputeOn([hostAgentsVersion], () =>
          buildAgentOpensAs({
            agent: agent.id,
            cliDetected: detected === null ? null : detected.includes(agent.id),
            chatProgramHere: chatOnly.has(agent.id),
            settings,
            updateSettings
          })
        )
        if (!opensAs) {
          return null
        }
        return managedChatAgents.has(agent.id) && !chatUnavailableOnThisDesktop(agent.id) ? (
          <ManagedChatAgentRow
            key={agent.id}
            agent={agent.id}
            label={agent.label}
            opensAs={opensAs}
          />
        ) : (
          <ChatAgentRow key={agent.id} agent={agent.id} label={agent.label} opensAs={opensAs} />
        )
      })}
    </SettingsGroup>
  )
}

type ChatAgentRowProps = { agent: TuiAgent; label: string; opensAs: AgentOpensAs }

function ChatAgentRow({
  agent,
  label,
  opensAs,
  line = null,
  actions = null
}: ChatAgentRowProps & { line?: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-settings-row=""
      className={cn('flex items-center justify-between gap-4 py-3', line && 'flex-wrap gap-y-2')}
    >
      <div className={cn('flex min-w-0 items-center gap-3', line && 'grow basis-40')}>
        <AgentIcon agent={agent} size={16} />
        <div className={cn('min-w-0', line && 'flex-1')}>
          <div className="text-sm font-medium">{label}</div>
          {line ? <div className="mt-0.5">{line}</div> : null}
        </div>
      </div>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2',
          line && 'ms-auto max-w-full flex-wrap justify-end'
        )}
      >
        {actions}
        <AgentOpensAsControl label={label} opensAs={opensAs} />
      </div>
    </div>
  )
}

/** Offers the agent's chat runtime install in its row until this computer has a current copy. */
function ManagedChatAgentRow(props: ChatAgentRowProps): React.JSX.Element {
  const { runtime, signInRunning } = useAgentChatRuntimeInstall(props.agent)
  if (runtime.kind !== 'active' || !managedRuntimeInstallPending(runtime.snapshot)) {
    return <ChatAgentRow {...props} />
  }
  return (
    <ManagedRuntimeInstallRow
      observation={runtime}
      agentLabel={props.label}
      signInRunning={signInRunning}
      menu={false}
    >
      {(line, actions) => <ChatAgentRow {...props} line={line} actions={actions} />}
    </ManagedRuntimeInstallRow>
  )
}
