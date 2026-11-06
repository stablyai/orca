import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { AgentCatalogRow } from './AgentCatalogRow'
import type { AgentPermissionChoiceRow } from '../../../agent/launch-settings/AgentPermissionChoiceControls'

const store = {
  settings: {
    ...getDefaultSettings('/fixture'),
    agentPermissionDefault: 'full-access' as const,
    agentPermissionOverrides: { claude: 'own' as const }
  }
}

// `source: 'agent'` is the only state that renders the header badge: the agent was given its
// own permission instead of following the all-agents choice.
const ownPermission: AgentPermissionChoiceRow = {
  choices: ['own', 'ask', 'accept-edits', 'auto', 'full-access'],
  choice: 'own',
  source: 'agent',
  defaultChoice: 'full-access',
  onSelect: () => {},
  flag: '',
  argsSetPermission: false
}

const row = (
  <AgentCatalogRow
    agentId="claude"
    label="Claude"
    homepageUrl="https://claude.com/claude-code"
    defaultCmd="claude"
    defaultArgs=""
    defaultEnv={{}}
    isDetected
    isEnabled
    isDefault
    cmdOverride={undefined}
    argsOverride=""
    envOverride={{}}
    onSetDefault={() => {}}
    onSetEnabled={() => {}}
    onSaveOverride={() => {}}
    onSaveArgs={() => {}}
    onSaveEnv={() => {}}
    permissionChoice={ownPermission}
  />
)

/** Collapsed: the badge is the only place the agent's own permission is visible. */
export const ownPermissionCollapsed = defineFixture({
  width: 860,
  store,
  render: () => row
})

/** Expanded: the Permissions control states the same choice, so the badge repeats it. */
export const ownPermissionExpanded = defineFixture({
  width: 860,
  store,
  render: () => row,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[aria-label="Expand agent settings"]')?.click()
  }
})
