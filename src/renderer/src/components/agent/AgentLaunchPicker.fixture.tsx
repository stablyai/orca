import { useState } from 'react'
import { Terminal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { AgentLaunchPicker } from './AgentLaunchPicker'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { NewTabAgentMenuModel } from './launch-menu/new-tab-agent-menu-model'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentSessionModelOption } from '../../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

const level = (value: string, label: string) => ({ value, label })
const CLAUDE_EFFORTS = [
  level('low', 'Low'),
  level('medium', 'Medium'),
  level('high', 'High'),
  level('xhigh', 'Extra high'),
  level('max', 'Max')
]
const CODEX_EFFORTS = CLAUDE_EFFORTS.slice(0, 4)

function model(
  id: string,
  label: string,
  efforts: AgentSessionModelOption['efforts'],
  extra: Partial<AgentSessionModelOption> = {}
): AgentSessionModelOption {
  return { id, label, isDefault: false, efforts, defaultEffort: 'medium', ...extra }
}

function entry(
  agent: TuiAgent,
  label: string,
  surfaces: AgentPickerEntry['surfaces'],
  models: AgentSessionModelOption[] = []
): AgentPickerEntry {
  return {
    agent,
    label,
    rows: [
      surfaces.includes('terminal')
        ? { kind: 'cli', agent, ...(surfaces.includes('chat') ? { chat: true as const } : {}) }
        : { kind: 'chat-unavailable', agent, reason: 'not-installed' }
    ],
    surfaces,
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: models.length
      ? { origin: 'probe', fetchedAt: 1, listingNamesConfiguredModel: true, models }
      : { origin: 'unknown' },
    catalogRead: 'settled'
  }
}

const claudeModels = [
  model('claude-opus-5-5', 'Claude Opus 5.5', CLAUDE_EFFORTS, {
    isDefault: true,
    supportsFastMode: true
  }),
  model('claude-sonnet-5-5', 'Claude Sonnet 5.5', CLAUDE_EFFORTS, { supportsFastMode: true }),
  model('claude-fable-5', 'Claude Fable 5', CLAUDE_EFFORTS),
  model('claude-haiku-5-5', 'Claude Haiku 5.5', CLAUDE_EFFORTS.slice(0, 3))
]
const fastTier = [{ value: 'fast', label: 'Fast' }]
const codexModels = [
  ['gpt-6.1-sol', 'GPT-6.1-Sol'],
  ['gpt-6.1-terra', 'GPT-6.1-Terra'],
  ['gpt-6-astra', 'GPT-6-Astra'],
  ['gpt-6-luna', 'GPT-6-Luna'],
  ['gpt-6-sol', 'GPT-6-Sol'],
  ['gpt-5.6-sol', 'GPT-5.6-Sol'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna'],
  ['gpt-5.5', 'GPT-5.5']
].map(([id, label], index) =>
  model(id, label, CODEX_EFFORTS, { isDefault: index === 0, serviceTiers: fastTier })
)

const ENTRIES: AgentPickerEntry[] = [
  entry('claude', 'Claude', ['chat', 'terminal'], claudeModels),
  entry('claude-agent-teams', 'Claude agent teams', ['terminal'], claudeModels),
  entry('codex', 'Codex', ['chat', 'terminal'], codexModels),
  entry('grok', 'Grok', ['terminal']),
  entry('opencode', 'OpenCode', []),
  entry('gemini', 'Gemini', ['terminal'])
]

const MODEL: NewTabAgentMenuModel = {
  state: 'settled',
  rows: ENTRIES.flatMap((row) => row.rows),
  detection: {
    detectedIds: ENTRIES.map((row) => row.agent),
    isLoading: false,
    isRefreshing: false,
    detectionFailed: false,
    needsServerUpdate: false,
    refresh: async () => ENTRIES.map((row) => row.agent)
  }
}

function HandOffField(): React.JSX.Element {
  const [pick, setPick] = useState<{ agent: TuiAgent; draft?: AgentPickerDraft }>({
    agent: 'claude',
    draft: {
      agent: 'claude',
      surface: 'terminal',
      choices: { model: 'claude-opus-5-5', options: { effort: 'medium' } }
    }
  })
  return (
    <div className="min-h-[470px] bg-background p-4">
      <div className="w-[420px] space-y-1.5">
        <label className="text-xs font-medium">Agent</label>
        <AgentLaunchPicker
          model={MODEL}
          entries={ENTRIES}
          agent={pick.agent}
          value={pick.draft}
          cli={pick.draft?.surface !== 'chat'}
          onPick={(agent, draft) => setPick({ agent, draft })}
        />
      </div>
    </div>
  )
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
const click = (selector: string) => document.querySelector<HTMLElement>(selector)?.click()
const openDropdown = async () => {
  const trigger = document.querySelector<HTMLElement>('[data-agent-launch-picker-trigger]')
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  await settle()
}

export const dropdownClaude = defineFixture({
  width: 460,
  render: () => <HandOffField />,
  interact: openDropdown
})

export const dropdownCodexMoreModels = defineFixture({
  width: 460,
  render: () => <HandOffField />,
  interact: async () => {
    await openDropdown()
    click('[role="tab"][aria-label="Codex"]')
    await settle()
    click('[cmdk-item][data-value="__legacy__"]')
    await settle()
  }
})

export const dropdownNotInstalled = defineFixture({
  width: 460,
  render: () => <HandOffField />,
  interact: async () => {
    await openDropdown()
    click('[role="tab"][aria-label="OpenCode"]')
    await settle()
  }
})

export const dropdownSearch = defineFixture({
  width: 460,
  render: () => <HandOffField />,
  interact: async () => {
    await openDropdown()
    const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'gpt 6'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await settle()
  }
})

export const dropdownWithBlankTerminal = defineFixture({
  width: 460,
  render: () => (
    <div className="min-h-[470px] bg-background p-4">
      <div className="w-[420px]">
        <AgentLaunchPicker
          model={MODEL}
          entries={ENTRIES}
          agent="codex"
          emptyLabel="Blank Terminal"
          onSelectBlankTerminal={() => {}}
          onPick={() => {}}
        />
      </div>
    </div>
  ),
  interact: openDropdown
})

/** The + menu: hovering an agent row opens the same card, without tabs, over the prompt and Launch. */
function NewTabMenu(): React.JSX.Element {
  return (
    <div className="min-h-[520px] bg-background p-4">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger className="sr-only">+</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <AgentLaunchPickerMenu
            model={MODEL}
            entries={ENTRIES}
            hideSearch
            runLaunch={() => true}
          />
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
            <Terminal className="size-4" />
            Terminal
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const newTabSubmenu = defineFixture({
  width: 760,
  render: () => <NewTabMenu />,
  interact: async () => {
    click('[aria-label="Configure Claude"]')
    await settle()
  }
})

export const newTabSubmenuCodex = defineFixture({
  width: 760,
  render: () => <NewTabMenu />,
  interact: async () => {
    click('[aria-label="Configure Codex"]')
    await settle()
  }
})

// Codex's widest effort row: every level it can advertise, then Fast.
const CODEX_ALL_EFFORTS = [level('minimal', 'Minimal'), ...CLAUDE_EFFORTS, level('ultra', 'Ultra')]
const WIDEST_ENTRIES = ENTRIES.map((row) =>
  row.agent === 'codex'
    ? entry(
        'codex',
        'Codex',
        ['chat', 'terminal'],
        [
          model('gpt-6.1-sol', 'GPT-6.1-Sol', CODEX_ALL_EFFORTS, {
            isDefault: true,
            serviceTiers: fastTier
          })
        ]
      )
    : row
)

/** The Settings › Source control recipe column: a 220px trigger. */
export const dropdownSettingsRecipeCodex = defineFixture({
  width: 460,
  render: () => (
    <div className="min-h-[360px] bg-background p-4">
      <div className="w-[220px]">
        <AgentLaunchPicker
          model={MODEL}
          entries={WIDEST_ENTRIES}
          agent="codex"
          value={{
            agent: 'codex',
            surface: 'terminal',
            choices: { model: 'gpt-6.1-sol', options: { effort: 'xhigh' } }
          }}
          onPick={() => {}}
        />
      </div>
    </div>
  ),
  interact: async () => {
    await openDropdown()
  }
})
