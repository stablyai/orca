import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { orchestrationMailFixture } from '../../../../../../shared/agent-session/orchestration-mail.test-fixture'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'

export const pluginSender = defineFixture({
  width: 720,
  setup: () =>
    usePluginPanelsStore.getState().setPlugins([
      {
        pluginKey: 'acme.inbox',
        consentFingerprint: null,
        name: 'Acme Inbox',
        version: '1.0.0',
        publisher: 'acme',
        status: 'running',
        needsReconsent: false,
        isDev: false,
        official: false,
        bundled: false,
        capabilities: [],
        panels: [],
        commands: [],
        hasWorker: true,
        restarts: 0
      }
    ]),
  render: () => {
    const message = orchestrationMailFixture()
    const address = 'plugin:acme.inbox'
    const from: AgentMessageSource = {
      ...message.from,
      senders: [{ name: null, party: { address, terminalHandle: address, orcaSessionId: null } }]
    }
    return (
      <div className="p-4">
        <NativeChatAgentMessageCard
          message={{ ...message, from }}
          from={from}
          onRefolded={() => {}}
        />
      </div>
    )
  }
})
