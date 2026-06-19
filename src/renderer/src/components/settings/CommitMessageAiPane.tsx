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
import { getSettingOwnershipSummary } from './setting-ownership'
import { translate } from '@/i18n/i18n'
import { HostedReviewCreationDefaults } from './HostedReviewCreationDefaults'

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
  const ownership = getSettingOwnershipSummary('sourceControlAiDefaults')
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
      title: translate(
        'auto.components.settings.CommitMessageAiPane.d5b45a3628',
        'Show Source Control AI actions'
      ),
      description: translate(
        'auto.components.settings.CommitMessageAiPane.7bcad2b200',
        'Adds action recipes for Source Control commit, pull request, branch-name, and fix actions.'
      ),
      keywords: [
        translate('auto.components.settings.CommitMessageAiPane.0b7eafe55f', 'ai'),
        translate('auto.components.settings.CommitMessageAiPane.ca433708cb', 'commit'),
        translate('auto.components.settings.CommitMessageAiPane.8cd2be0948', 'message'),
        translate('auto.components.settings.CommitMessageAiPane.34d0348e34', 'generate'),
        translate('auto.components.settings.CommitMessageAiPane.4ec89c319e', 'agent'),
        translate('auto.components.settings.CommitMessageAiPane.d54c64163d', 'enabled')
      ]
    })
  ) {
    sections.push(
      <SearchableSetting
        key="enabled"
        title={translate(
          'auto.components.settings.CommitMessageAiPane.d5b45a3628',
          'Show Source Control AI actions'
        )}
        description={translate(
          'auto.components.settings.CommitMessageAiPane.7bcad2b200',
          'Adds action recipes for Source Control commit, pull request, branch-name, and fix actions.'
        )}
        keywords={['ai', 'commit', 'message', 'generate', 'agent', 'enabled']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-1">
          <Label>
            {translate(
              'auto.components.settings.CommitMessageAiPane.d5b45a3628',
              'Show Source Control AI actions'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CommitMessageAiPane.2339a89104',
              'Adds AI buttons that run the selected agent with the command template for that action.'
            )}
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
        title: translate(
          'auto.components.settings.CommitMessageAiPane.47e45cbd5a',
          'Custom command'
        ),
        description: translate(
          'auto.components.settings.CommitMessageAiPane.1ef29f8c29',
          'Command line Orca runs when a text recipe uses Custom command.'
        ),
        keywords: [
          translate('auto.components.settings.CommitMessageAiPane.25350d670f', 'custom'),
          translate('auto.components.settings.CommitMessageAiPane.54038660e0', 'command'),
          translate('auto.components.settings.CommitMessageAiPane.407d28bde6', 'cli'),
          translate('auto.components.settings.CommitMessageAiPane.1df7d71313', 'binary'),
          translate('auto.components.settings.CommitMessageAiPane.a69e1fe91a', 'prompt'),
          translate('auto.components.settings.CommitMessageAiPane.fc1a525fa5', 'placeholder')
        ]
      }))
  ) {
    sections.push(
      <SearchableSetting
        key="custom-command"
        title={translate(
          'auto.components.settings.CommitMessageAiPane.47e45cbd5a',
          'Custom command'
        )}
        description={translate(
          'auto.components.settings.CommitMessageAiPane.1ef29f8c29',
          'Command line Orca runs when a text recipe uses Custom command.'
        )}
        keywords={['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']}
        className="space-y-2 py-2"
      >
        <div className="space-y-0.5">
          <Label htmlFor="source-control-ai-custom-command">
            {translate('auto.components.settings.CommitMessageAiPane.47e45cbd5a', 'Custom command')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CommitMessageAiPane.4f722a5f53',
              'Used by commit-message, pull-request, and branch-name recipes that select Custom command. Use'
            )}
            <code className="font-mono">
              {translate('auto.components.settings.CommitMessageAiPane.b8b6fd55b4', '{prompt}')}
            </code>{' '}
            {translate(
              'auto.components.settings.CommitMessageAiPane.3f1b26cc91',
              'to pass the command input as an argument; otherwise Orca pipes it on stdin.'
            )}
          </p>
        </div>
        <Input
          id="source-control-ai-custom-command"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={config.customAgentCommand}
          onChange={(event) => onCustomCommandChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.CommitMessageAiPane.15b60d54b2',
            'e.g. ollama run llama3.1 {prompt}'
          )}
          className="h-8 font-mono text-xs"
        />
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    matchesSettingsSearch(searchQuery, {
      title: translate(
        'auto.components.settings.CommitMessageAiPane.2dafc7646e',
        'Hosted-review creation defaults'
      ),
      description: translate(
        'auto.components.settings.CommitMessageAiPane.e9d46a544d',
        'Defaults used when the hosted-review composer opens.'
      ),
      keywords: [
        translate('auto.components.settings.CommitMessageAiPane.19e10a12bb', 'hosted review'),
        translate('auto.components.settings.CommitMessageAiPane.b388463881', 'pull request'),
        translate('auto.components.settings.CommitMessageAiPane.fdee745b87', 'merge request'),
        translate('auto.components.settings.CommitMessageAiPane.02bab6542c', 'pr'),
        translate('auto.components.settings.CommitMessageAiPane.ebed4d2a29', 'draft'),
        translate('auto.components.settings.CommitMessageAiPane.6c84ba6de3', 'template'),
        translate('auto.components.settings.CommitMessageAiPane.34d0348e34', 'generate'),
        translate('auto.components.settings.CommitMessageAiPane.2c5436c018', 'open')
      ]
    })
  ) {
    const prDefaults = config.prCreationDefaults ?? {}
    sections.push(
      <HostedReviewCreationDefaults
        key="pr-creation-defaults"
        prDefaults={prDefaults}
        onPrDefaultChange={onPrDefaultChange}
      />
    )
  }

  return (
    <div
      id="source-control-ai-settings"
      data-settings-section="source-control-ai-settings"
      className="space-y-4 border-t border-border/40 pt-4"
    >
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.CommitMessageAiPane.ad66ff886d',
            'Source Control AI defaults'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">{ownership.description}</p>
      </div>
      {sections}
    </div>
  )
}
