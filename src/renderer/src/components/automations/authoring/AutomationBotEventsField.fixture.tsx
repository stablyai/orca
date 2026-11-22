import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatAutomationSavedRow } from '../../native-chat/automation-run/NativeChatAutomationSavedRow'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationConnectorEventTrigger,
  type AutomationEventTrigger
} from '../../../../../shared/automation-event-triggers'
import { AutomationBotEventsField } from './AutomationBotEventsField'

const THREAD = 'slack:T0ACME:C0DEPLOYS:1793590000.000100'
const CHANNEL = 'slack:T0ACME:C0DEPLOYS'
const NAMES = { [THREAD]: '#orca', [CHANNEL]: '#orca', U0NORA: 'Nora' }

// Saved with names, as a save on this build keeps them.
const named: AutomationConnectorEventTrigger[] = [
  {
    id: 'on-1',
    source: 'slack',
    event: 'message',
    subject: THREAD,
    from: ['U0NORA'],
    names: NAMES
  },
  {
    id: 'on-2',
    source: 'slack',
    event: 'message',
    in: [CHANNEL],
    from: ['U0NORA'],
    names: NAMES
  },
  {
    id: 'on-3',
    source: 'github',
    event: 'pr_opened',
    in: ['github:42:777'],
    names: { 'github:42:777': 'stablyai/orca' }
  },
  {
    id: 'on-4',
    source: 'linear',
    event: 'mentioned',
    subject: 'linear:org-1:issue-42',
    names: { 'linear:org-1:issue-42': 'ENG-42' }
  }
]

// The same rules saved before names.
const older: AutomationEventTrigger[] = named.map((rule) => ({ ...rule, names: undefined }))

function Panel({ triggers }: { triggers: AutomationEventTrigger[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-4">
      <AutomationBotEventsField triggers={triggers} onEditInChat={() => {}} />
      <NativeChatAutomationSavedRow
        timestamp={null}
        saved={{
          change: 'created',
          resultsTo: 'thread',
          automation: {
            id: 'auto-1',
            name: 'Answer Nora in #orca',
            enabled: true,
            nextRunAt: 0,
            updatedAt: 0,
            ...EVENT_ONLY_SCHEDULE,
            workspaceId: null,
            on: triggers.slice(0, 2)
          }
        }}
      />
    </div>
  )
}

export const withNames = defineFixture({ width: 560, render: () => <Panel triggers={named} /> })

export const savedBeforeNames = defineFixture({
  width: 560,
  render: () => <Panel triggers={older} />
})

// Your own pull requests start these: from=me alone, and beside people named or saved before names.
const own: AutomationEventTrigger[] = [
  { id: 'own-1', source: 'github', event: 'pr_opened', in: ['acme/web'], fromOwner: true },
  {
    id: 'own-2',
    source: 'github',
    event: 'pr_opened',
    in: ['acme/web'],
    from: ['300'],
    names: { '300': 'Dana' },
    fromOwner: true
  },
  {
    id: 'own-3',
    source: 'github',
    event: 'pr_opened',
    in: ['acme/web'],
    from: ['200', '300'],
    names: { '200': 'Nora', '300': 'Dana' },
    fromOwner: true
  },
  {
    id: 'own-4',
    source: 'github',
    event: 'pr_opened',
    in: ['acme/web'],
    from: ['200', '300'],
    fromOwner: true
  }
]

export const fromMe = defineFixture({
  width: 560,
  render: () => (
    <div className="p-4">
      <AutomationBotEventsField triggers={own} onEditInChat={() => {}} />
    </div>
  )
})
