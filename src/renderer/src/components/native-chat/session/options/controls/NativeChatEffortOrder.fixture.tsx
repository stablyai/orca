import { useState } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { AgentLaunchPicker } from '../../../../agent/AgentLaunchPicker'
import { AgentChoiceControls } from '../../../../agent/launch-settings/AgentChoiceControls'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentDedicatedChoices } from '../../../../../../../shared/agent-launch/choices/agent-launch-choices'
import type { AgentSessionModelCatalogResult } from '../../../../../../../shared/agent-session/agent-session-wire'

// Grok's ACP listing reports its levels highest-first; the fixtures feed that order as-is.
const GROK_EFFORTS = [
  { value: 'xhigh', label: 'Extra High', description: 'Maximum reasoning for the hardest tasks.' },
  { value: 'high', label: 'High', description: 'Thorough reasoning and quality. Recommended.' },
  { value: 'medium', label: 'Medium', description: 'Strong quality with a faster turnaround.' },
  { value: 'low', label: 'Low', description: 'Fastest responses. Best for simple tasks.' }
]

const SNAPSHOT: SessionOptionDescriptor[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: {
      type: 'select',
      currentValue: 'grok-4.7',
      choices: [
        { value: 'grok-4.7', label: 'Grok 4.7' },
        { value: 'grok-4.6', label: 'Grok 4.6' }
      ]
    }
  },
  {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    transport: 'agent-session',
    settable: true,
    valueSource: 'applied',
    kind: { type: 'select', currentValue: 'high', choices: GROK_EFFORTS }
  }
]

const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

export const grokComposerPicker = defineFixture({
  width: 420,
  render: () => (
    <div className="flex min-h-[360px] items-end bg-background p-4">
      <NativeChatSessionOptionPickers
        surface={{
          getSnapshot: () => SNAPSHOT,
          subscribe: () => () => {},
          setOption: async () => ({ snapshot: SNAPSHOT }),
          invokeAction: async () => ({ snapshot: SNAPSHOT })
        }}
        snapshot={SNAPSHOT}
      />
    </div>
  ),
  interact: async () => {
    document
      .querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    document.querySelector<HTMLElement>('button[aria-haspopup="dialog"]')?.click()
    await settle()
  }
})

const GROK_MODELS = [
  {
    id: 'grok-4.7',
    label: 'Grok 4.7',
    isDefault: true,
    efforts: GROK_EFFORTS,
    defaultEffort: 'high'
  }
]

const GROK_ENTRY: AgentPickerEntry = {
  agent: 'grok',
  label: 'Grok',
  rows: [{ kind: 'cli', agent: 'grok', chat: true }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    listingNamesConfiguredModel: true,
    models: GROK_MODELS
  },
  catalogRead: 'settled'
}

function GrokLaunchField(): React.JSX.Element {
  const [draft, setDraft] = useState<AgentPickerDraft>({
    agent: 'grok',
    surface: 'chat',
    choices: { model: 'grok-4.7', options: { effort: 'high' } }
  })
  return (
    <div className="min-h-[420px] bg-background p-4">
      <div className="w-[420px]">
        <AgentLaunchPicker
          model={{
            state: 'settled',
            rows: GROK_ENTRY.rows,
            detection: {
              detectedIds: ['grok'],
              isLoading: false,
              isRefreshing: false,
              detectionFailed: false,
              needsServerUpdate: false,
              refresh: async () => ['grok']
            }
          }}
          entries={[GROK_ENTRY]}
          agent="grok"
          value={draft}
          onPick={(_agent, next) => next && setDraft(next)}
        />
      </div>
    </div>
  )
}

const openLaunchPicker = async () => {
  document
    .querySelector<HTMLElement>('[data-agent-launch-picker-trigger]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  await settle()
}

export const grokLaunchPicker = defineFixture({
  width: 460,
  render: () => <GrokLaunchField />,
  interact: openLaunchPicker
})

const GROK_LIVE: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  models: GROK_MODELS
}

// A saved level the listing omits (Medium here) is appended to the menu.
const GROK_LIVE_WITHOUT_MEDIUM: AgentSessionModelCatalogResult = {
  ...GROK_LIVE,
  models: GROK_MODELS.map((model) => ({
    ...model,
    efforts: model.efforts.filter((effort) => effort.value !== 'medium')
  }))
}

function GrokSettingsEffort(props: {
  initial: AgentDedicatedChoices
  live: AgentSessionModelCatalogResult
}): React.JSX.Element {
  const [value, setValue] = useState<AgentDedicatedChoices | undefined>(props.initial)
  return (
    <div className="min-h-[300px] w-[360px] bg-background p-4">
      <AgentChoiceControls
        agent="grok"
        value={value}
        liveCatalog={props.live}
        layout="rows"
        onChange={setValue}
      />
    </div>
  )
}

const openLastMenu = async () => {
  const triggers = document.querySelectorAll<HTMLElement>(
    'button[role="combobox"], button[aria-haspopup]'
  )
  const trigger = [...triggers].at(-1)
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  trigger?.click()
  await settle()
}

export const grokSettingsEffortMenu = defineFixture({
  width: 400,
  render: () => <GrokSettingsEffort initial={{ model: 'grok-4.7' }} live={GROK_LIVE} />,
  interact: openLastMenu
})

export const grokSettingsSavedEffortMenu = defineFixture({
  width: 400,
  render: () => (
    <GrokSettingsEffort
      initial={{ options: { effort: 'medium' } }}
      live={GROK_LIVE_WITHOUT_MEDIUM}
    />
  ),
  interact: openLastMenu
})
