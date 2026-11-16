import { useState } from 'react'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { AGENT_CATALOG } from '@/lib/agent-catalog/agent-catalog'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AutomationAgentLaunchPicker } from './AutomationAgentLaunchPicker'
import type { AutomationDraft } from './AutomationEditorDialog'

const DRAFT: AutomationDraft = {
  name: 'Nightly triage',
  prompt: 'Triage new issues',
  agentId: 'claude',
  surface: 'terminal',
  extraAgentArgs: '',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: 'main',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '',
  preset: 'daily',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  savedSchedule: null,
  missedRunGraceMinutes: '',
  scheduleWarning: null
}

function AgentField(): React.JSX.Element {
  const [draft, setDraft] = useState(DRAFT)
  return (
    <div className="min-h-[260px] space-y-1.5 bg-background p-4">
      <label className="text-xs font-medium">Agent</label>
      <AutomationAgentLaunchPicker
        draft={draft}
        workspace={{ kind: 'git-worktree', repoId: 'repo-1' }}
        authority={{ kind: 'desktop' }}
        visibleAgents={AGENT_CATALOG.filter((agent) => ['claude', 'codex'].includes(agent.id))}
        settings={getDefaultSettings('/tmp')}
        surface="terminal"
        chatSupported
        onDraftChange={(update) => setDraft(update)}
      />
    </div>
  )
}

/** Launch setup hosts: Permissions and Arguments sit under the agent picker. */
export const launchSetupFields = defineFixture({
  width: 420,
  store: { localDetectedAgentIdsByContext: { host: ['claude', 'codex'] } },
  render: () => <AgentField />,
  interact: () => new Promise((resolve) => setTimeout(resolve, 300))
})
