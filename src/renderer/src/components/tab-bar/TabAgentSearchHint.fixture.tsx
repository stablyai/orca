import { useRef, useState } from 'react'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { TabEntrySearchField } from './TabEntrySearchField'
import { createTabAgentSearchHintSession } from './tab-agent-search-hint-session'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Input } from '@/components/ui/input'
import { TabAgentSearchHint } from './TabAgentSearchHint'
import { getTabEntryOmniboxPlaceholder } from './tab-create-entry-copy'

export const firstTime = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-background p-4 text-foreground">
      <div className="rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-floating">
        <div className="tab-entry-omnibox relative -mx-1 flex items-center px-3 text-xs text-foreground">
          <Input variant="omnibox" highlighted placeholder={getTabEntryOmniboxPlaceholder()} />
        </div>
        <TabAgentSearchHint
          examples={['Opus (1M context)', '6.1-terra']}
          onDismiss={() => {}}
          onTry={() => {}}
        />
      </div>
    </div>
  ),
  interact: (frame) => frame.querySelector('input')?.focus()
})

function InteractiveHint(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [session] = useState(createTabAgentSearchHintSession)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="bg-background p-4 text-foreground">
      <div className="rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-floating">
        <TabEntrySearchField
          agentPickerEntries={entries}
          eligibleForHint
          hintSession={session}
          inputRef={inputRef}
          value={query}
          onQueryChange={setQuery}
        />
      </div>
    </div>
  )
}

export const interactive = defineFixture({
  width: 320,
  store: { persistedUIReady: true },
  setup: () => {
    localStorage.removeItem('orca.tabAgentSearchHint.v1')
    window.api.telemetryClaimTabAgentSearchHint = async () => 'treatment'
  },
  render: () => <InteractiveHint />
})

export const ordinary = defineFixture({
  width: 320,
  store: { persistedUIReady: true },
  setup: () => {
    localStorage.removeItem('orca.tabAgentSearchHint.v1')
    window.api.telemetryClaimTabAgentSearchHint = async () => 'control'
  },
  render: () => <InteractiveHint />
})

const entries: AgentPickerEntry[] = [
  {
    agent: 'claude',
    label: 'Claude',
    rows: [{ agent: 'claude', kind: 'chat' }],
    surfaces: ['chat'],
    defaultSurface: 'chat',
    terminal: {},
    structured: {},
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus[1m]', label: 'Opus (1M context)', isDefault: true, efforts: [] }]
    }
  }
]
