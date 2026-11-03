import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useEffect } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { readChatProgram, resolveChatProgramContext } from '@/lib/host-chat-program'
import { useChatProgramFacts } from '@/lib/host-chat-program-acquisition'
import { useAppStore } from '@/store/index'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { Card, CardContent } from '../../ui/card'
import { AgentOpensAsControl } from '../AgentChatChoiceControls'
import { buildAgentOpensAs } from '../native-chat-provider-choice'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import { getChatLaunchEntriesByKey } from './chat-launch-search'

const WORKSPACE = { kind: 'floating' } as const

export function ChatAgentLaunchSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  useHostStructuredAgentsVersion()
  useChatProgramFacts(WORKSPACE)
  useEffect(() => {
    void useAppStore.getState().ensureNativeDetectedAgents()
  }, [])
  const detected = useAppStore(readNativeDetectedAgents)
  const chatOnlyKey = useAppStore((state) => {
    const context = resolveChatProgramContext(state, WORKSPACE)
    return chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
      .filter(
        (agent) =>
          !detected?.includes(agent) &&
          readChatProgram(state, agent, context, detected) === 'available'
      )
      .join(' ')
  })
  const chatOnly = new Set(chatOnlyKey.split(' '))
  const entry = getChatLaunchEntriesByKey().agents
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={entry.title} description={entry.description} />
      <Card size="list">
        <CardContent>
          <div className="divide-y divide-border">
            {getAgentCatalog().map((agent) => {
              const opensAs = buildAgentOpensAs({
                agent: agent.id,
                cliDetected: detected === null ? null : detected.includes(agent.id),
                chatProgramHere: chatOnly.has(agent.id),
                settings,
                updateSettings
              })
              return opensAs ? (
                <div key={agent.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <AgentIcon agent={agent.id} size={16} />
                    <span className="text-sm font-medium">{agent.label}</span>
                  </div>
                  <AgentOpensAsControl label={agent.label} opensAs={opensAs} />
                </div>
              ) : null
            })}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
