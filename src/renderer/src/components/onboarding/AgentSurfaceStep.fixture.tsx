import { defineFixture } from '../../component-fixtures/component-fixture'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentSurfaceStep } from './AgentSurfaceStep'
import { AgentStep } from './AgentStep'
import { ChatModeTerminalTip } from './AgentStepSurfaceSections'

const detected = new Set<TuiAgent>(['claude', 'codex', 'aider', 'gemini'])
const chatAgents: TuiAgent[] = ['claude', 'codex', 'pi', 'grok', 'opencode', 'antigravity']

export const chooseChat = defineFixture({
  width: 1000,
  render: () => <AgentSurfaceStep agentSurface="chat" onSelect={() => {}} />
})

export const chooseWithoutChatAgents = defineFixture({
  width: 1000,
  render: () => <AgentSurfaceStep agentSurface="terminal" onSelect={() => {}} noChatAgentDetected />
})

export const chatAgentsPage = defineFixture({
  width: 1000,
  render: () => (
    <div className="flex h-[640px] flex-col">
      <AgentStep
        agentSurface="chat"
        selectedAgent="aider"
        onSelect={() => {}}
        detectedSet={detected}
        isDetecting={false}
        chatAgents={chatAgents}
        chatDetected={['claude', 'codex']}
      />
    </div>
  )
})

export const terminalAgentsPage = defineFixture({
  width: 1000,
  render: () => (
    <div className="flex h-[640px] flex-col">
      <AgentStep
        agentSurface="terminal"
        selectedAgent="claude"
        onSelect={() => {}}
        detectedSet={detected}
        isDetecting={false}
        chatAgents={chatAgents}
        chatDetected={['claude', 'codex']}
      />
    </div>
  )
})

export const setupGuideAgentsPage = defineFixture({
  width: 760,
  render: () => (
    <div className="flex h-[640px] flex-col">
      <AgentStep
        agentSurface="chat"
        onAgentSurfaceChange={() => {}}
        agentSurfaceSwitchable
        selectedAgent="claude"
        onSelect={() => {}}
        detectedSet={detected}
        isDetecting={false}
        chatAgents={chatAgents}
        chatDetected={['claude', 'codex']}
      />
    </div>
  )
})

export const terminalTipDemo = defineFixture({
  width: 520,
  render: () => (
    <div className="pt-[300px]">
      <ChatModeTerminalTip />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector('button')?.focus()
  }
})
