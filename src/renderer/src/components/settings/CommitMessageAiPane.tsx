import { useRef } from 'react'
import type React from 'react'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type {
  SourceControlAiSettingsPatch,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import {
  normalizeSourceControlAiSettings,
  readSourceControlAiModelChoiceForHost,
  selectSourceControlAiModelChoiceForHost
} from '../../../../shared/source-control-ai'
import { SOURCE_CONTROL_TEXT_ACTION_IDS } from '../../../../shared/source-control-ai-actions'
import {
  CUSTOM_AGENT_ID,
  isCustomAgentId,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../shared/commit-message-host-key'
import { getRuntimeGitScope } from '../../runtime/runtime-git-client'
import { useAppStore } from '../../store'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SourceControlAiActionRecipeDefaults } from './SourceControlAiActionRecipeDefaults'
import { matchesSettingsSearch } from './settings-search'

type CommitMessageAiPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  writeSourceControlAiSettings?: (patch: SourceControlAiSettingsPatch) => Promise<void>
  onCustomPromptDirtyChange?: (dirty: boolean) => void
  customPromptDiscardSignal?: number
  settingsSearchQuery?: string
}

function readSettings(settings: GlobalSettings): SourceControlAiSettings {
  return normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
}

export function mergeDiscoveredModelsIntoCommitMessageConfig(
  config: SourceControlAiSettings,
  agentId: TuiAgent,
  models: CommitMessageModelCapability[],
  defaultModelId: string,
  hostKey = 'local'
): SourceControlAiSettings {
  const currentChoice = {
    selectedModelByAgent: config.selectedModelByAgent,
    selectedModelByAgentByHost: config.selectedModelByAgentByHost
  }
  const persisted = readSourceControlAiModelChoiceForHost(currentChoice, hostKey, agentId)
  const nextModelId = models.some((model) => model.id === persisted) ? persisted : defaultModelId
  const selectedModelChoice =
    nextModelId && nextModelId !== persisted
      ? selectSourceControlAiModelChoiceForHost(currentChoice, hostKey, agentId, nextModelId)
      : currentChoice
  return {
    ...config,
    discoveredModelsByAgent:
      hostKey === 'local'
        ? {
            ...config.discoveredModelsByAgent,
            [agentId]: models
          }
        : config.discoveredModelsByAgent,
    discoveredModelsByAgentByHost: {
      ...config.discoveredModelsByAgentByHost,
      [hostKey]: {
        ...config.discoveredModelsByAgentByHost?.[hostKey],
        [agentId]: models
      }
    },
    selectedModelByAgent: selectedModelChoice.selectedModelByAgent ?? config.selectedModelByAgent,
    selectedModelByAgentByHost: selectedModelChoice.selectedModelByAgentByHost
  }
}

export function getCommitMessageSettingsPaneDiscoveryHostKey(
  settings: GlobalSettings,
  activeConnectionId: string | null | undefined,
  hasActiveWorktree: boolean
): string {
  const runtimeScope = hasActiveWorktree
    ? getRuntimeGitScope(settings, activeConnectionId)
    : activeConnectionId
  return getCommitMessageModelDiscoveryHostKeyForScope(runtimeScope)
}

export function CommitMessageAiPane({
  settings,
  updateSettings,
  writeSourceControlAiSettings,
  onCustomPromptDirtyChange,
  customPromptDiscardSignal,
  settingsSearchQuery
}: CommitMessageAiPaneProps): React.JSX.Element {
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery
  const config = readSettings(settings)
  const settingsWriteQueueRef = useRef<Promise<void>>(Promise.resolve())

  const localWriteConfig = (patch: SourceControlAiSettingsPatch): Promise<void> => {
    const next = settingsWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const latestSettings = useAppStore.getState().settings ?? settings
        const current = readSettings(latestSettings)
        const resolvedPatch = typeof patch === 'function' ? patch(current) : patch
        await updateSettings({
          sourceControlAi: {
            ...current,
            ...resolvedPatch
          }
        })
      })
    settingsWriteQueueRef.current = next
    return next
  }
  const writeConfig = writeSourceControlAiSettings ?? localWriteConfig

  const onToggleEnabled = (): void => {
    void writeConfig({ enabled: !config.enabled })
  }

  const onCustomCommandChange = (value: string): void => {
    void writeConfig({ customAgentCommand: value })
  }

  const onPrDefaultChange = (
    key: keyof NonNullable<SourceControlAiSettings['prCreationDefaults']>,
    value: boolean
  ): void => {
    void writeConfig((current) => ({
      prCreationDefaults: {
        ...current.prCreationDefaults,
        [key]: value
      }
    }))
  }

  const sections: React.ReactNode[] = []
  const customCommandInUse =
    isCustomAgentId(config.agentId) ||
    config.customAgentCommand.trim().length > 0 ||
    SOURCE_CONTROL_TEXT_ACTION_IDS.some(
      (actionId) => config.actions?.[actionId]?.agentId === CUSTOM_AGENT_ID
    )

  if (
    matchesSettingsSearch(searchQuery, {
      title: 'Show Source Control AI actions',
      description:
        'Adds action recipes for Source Control commit, pull request, branch-name, and fix actions.',
      keywords: ['ai', 'commit', 'message', 'generate', 'agent', 'enabled']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="enabled"
        title="Show Source Control AI actions"
        description="Adds action recipes for Source Control commit, pull request, branch-name, and fix actions."
        keywords={['ai', 'commit', 'message', 'generate', 'agent', 'enabled']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-1">
          <Label>Show Source Control AI actions</Label>
          <p className="text-xs text-muted-foreground">
            Adds AI buttons that run the selected agent with the command template for that action.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={config.enabled}
          onClick={onToggleEnabled}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            config.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              config.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
    )
  }

  sections.push(
    <SourceControlAiActionRecipeDefaults
      key="action-recipes"
      config={config}
      defaultTuiAgent={settings.defaultTuiAgent}
      customPromptDiscardSignal={customPromptDiscardSignal}
      onCustomPromptDirtyChange={onCustomPromptDirtyChange}
      searchQuery={searchQuery}
      writeConfig={writeConfig}
    />
  )

  if (
    config.enabled &&
    (customCommandInUse ||
      matchesSettingsSearch(searchQuery, {
        title: 'Custom command',
        description: 'Command line Orca runs when a text recipe uses Custom command.',
        keywords: ['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']
      }))
  ) {
    sections.push(
      <SearchableSetting
        key="custom-command"
        title="Custom command"
        description="Command line Orca runs when a text recipe uses Custom command."
        keywords={['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']}
        className="space-y-2 py-2"
      >
        <div className="space-y-0.5">
          <Label htmlFor="source-control-ai-custom-command">Custom command</Label>
          <p className="text-xs text-muted-foreground">
            Used by commit-message, pull-request, and branch-name recipes that select Custom
            command. Use <code className="font-mono">{'{prompt}'}</code> to pass the command input
            as an argument; otherwise Orca pipes it on stdin.
          </p>
        </div>
        <Input
          id="source-control-ai-custom-command"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={config.customAgentCommand}
          onChange={(event) => onCustomCommandChange(event.target.value)}
          placeholder="e.g. ollama run llama3.1 {prompt}"
          className="h-8 font-mono text-xs"
        />
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    matchesSettingsSearch(searchQuery, {
      title: 'Hosted-review creation defaults',
      description: 'Defaults used when the hosted-review composer opens.',
      keywords: [
        'hosted review',
        'pull request',
        'merge request',
        'pr',
        'draft',
        'template',
        'generate',
        'open'
      ]
    })
  ) {
    const prDefaults = config.prCreationDefaults ?? {}
    const rows: {
      key: keyof NonNullable<SourceControlAiSettings['prCreationDefaults']>
      label: string
      description: string
    }[] = [
      {
        key: 'draft',
        label: 'Draft by default',
        description: 'Create hosted reviews as drafts unless changed in the composer.'
      },
      {
        key: 'useTemplate',
        label: 'Use review template when available',
        description: 'Prefer repository pull request templates when no description is set.'
      },
      {
        key: 'generateDetailsOnOpen',
        label: 'Generate details when opening Create PR',
        description: 'Run hosted-review detail generation once when the composer opens.'
      },
      {
        key: 'openAfterCreate',
        label: 'Open hosted review after creation',
        description: 'Open the created hosted review in your browser after submit.'
      }
    ]
    sections.push(
      <SearchableSetting
        key="pr-creation-defaults"
        title="Hosted-review creation defaults"
        description="Defaults used when the hosted-review composer opens."
        keywords={[
          'hosted review',
          'pull request',
          'merge request',
          'pr',
          'draft',
          'template',
          'generate',
          'open'
        ]}
        className="space-y-3 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Hosted-review creation defaults</Label>
          <p className="text-xs text-muted-foreground">
            Used by repositories that inherit global hosted-review defaults.
          </p>
        </div>
        <div className="space-y-2">
          {rows.map((row) => (
            <label
              key={row.key}
              className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2"
            >
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-foreground">{row.label}</span>
                <span className="block text-[11px] text-muted-foreground">{row.description}</span>
              </span>
              <input
                type="checkbox"
                checked={prDefaults[row.key] === true}
                onChange={(event) => onPrDefaultChange(row.key, event.target.checked)}
                className="mt-0.5 size-4 rounded border-border accent-primary"
              />
            </label>
          ))}
        </div>
      </SearchableSetting>
    )
  }

  return (
    <div
      id="source-control-ai-settings"
      data-settings-section="source-control-ai-settings"
      className="space-y-4 border-t border-border/40 pt-4"
    >
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Source Control AI defaults</h3>
        <p className="text-xs text-muted-foreground">
          Used by repositories that have not customized Source Control AI.
        </p>
      </div>
      {sections}
    </div>
  )
}
