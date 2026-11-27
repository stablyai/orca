import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { McpServerAgentsGroup } from './McpServerAgentsGroup'

const server = {
  id: 'linear-0000000001',
  name: 'linear',
  detail: 'https://mcp.linear.app/mcp',
  transport: 'http' as const,
  remote: false,
  signIn: { state: 'signed-in' as const, limited: false },
  agentsOff: [],
  workspaces: { later: true, on: [], off: [] },
  sharedProcess: false
}

/** An organization's Claude settings refuse Orca's servers: the Claude row says so (d10). */
export const blockedForClaude = defineFixture({
  width: 720,
  render: () => (
    <ConfirmationDialogProvider>
      <div className="settings-view-shell bg-background p-6">
        <McpServerAgentsGroup
          target={{ kind: 'local' }}
          server={server}
          agents={['claude', 'codex', 'opencode', 'copilot', 'pi']}
          agentFiles={{ grok: false, cursor: false, droid: false }}
          agentProblems={{
            claude: { kind: 'blocked', detail: 'Blocked by your organization’s Claude settings' }
          }}
        />
      </div>
    </ConfirmationDialogProvider>
  )
})
