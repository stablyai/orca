import { defineFixture } from '../../../component-fixtures/component-fixture'
import { McpDiscoveredRow } from './McpServerRows'

const found = {
  detail: '',
  transport: 'http' as const,
  files: [],
  projectNames: [],
  movable: true
}

/** "In your agents": Move takes GitHub out of Claude Code and Codex; Figma lives only in Gemini CLI,
 *  which Orca never launches with its list, so its row offers Copy. */
export const inYourAgents = defineFixture({
  width: 720,
  render: () => (
    <div className="settings-view-shell bg-background p-6">
      <McpDiscoveredRow
        server={{
          ...found,
          key: 'github',
          name: 'github',
          detail: 'https://api.githubcopilot.com/mcp/',
          agents: ['claude', 'codex', 'gemini'],
          removesFrom: ['claude', 'codex']
        }}
        busy={false}
        onMove={() => {}}
        onCopy={() => {}}
      />
      <McpDiscoveredRow
        server={{
          ...found,
          key: 'figma',
          name: 'figma',
          detail: 'https://mcp.figma.com/mcp',
          agents: ['gemini'],
          removesFrom: []
        }}
        busy={false}
        onMove={() => {}}
        onCopy={() => {}}
      />
    </div>
  )
})
