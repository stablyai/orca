import { useRef } from 'react'
import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  SourceControlAiSettingsPatch,
  SourceControlAiSettings
} from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { normalizeSourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import {
  readSourceControlAiModelChoiceForHost,
  selectSourceControlAiModelChoiceForHost,
  withDiscoveredModels
} from '../../../../../shared/source-control/ai/settings/source-control-ai-model-selection'
import { SOURCE_CONTROL_TEXT_ACTION_IDS } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'

import {
  CUSTOM_AGENT_ID,
  isCustomAgentId,
  type CommitMessageModelCapability
} from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../../shared/source-control/ai/generation/commit-message-host-key'
import { getRuntimeGitScope } from '../../../runtime/source-control/git/runtime-git-client-context'
import { useAppStore } from '../../../store/index'
import { CustomAgentCommandField } from './CustomAgentCommandField'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SourceControlAiActionRecipeDefaults } from './SourceControlAiActionRecipeDefaults'
import { matchesSettingsSearch } from '../search/settings-search'
import { getSettingOwnershipSummary } from '../page/setting-ownership'
import { useTranslate } from '@/i18n/use-translate'
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
    ...withDiscoveredModels(config, agentId, models, hostKey),
    selectedModelByAgent: selectedModelChoice.selectedModelByAgent ?? config.selectedModelByAgent,
    selectedModelByAgentByHost: selectedModelChoice.selectedModelByAgentByHost
  }
}

export function getCommitMessageSettingsPaneDiscoveryHostKey(
  target: RuntimeClientTarget,
  activeConnectionId: string | null | undefined,
  hasActiveWorktree: boolean
): string {
  const runtimeScope = hasActiveWorktree
    ? getRuntimeGitScope(target, activeConnectionId)
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
  const t = useTranslate()
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery
  const config = readSettings(settings)
  const ownership = getSettingOwnershipSummary('sourceControlAiDefaults', t)
  const settingsWriteQueueRef = useRef<Promise<void>>(undefined!)
  settingsWriteQueueRef.current ??= Promise.resolve()

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

  const writeImmediateConfig = (patch: SourceControlAiSettingsPatch): void => {
    void writeConfig(patch).catch((error: unknown) => {
      console.error('Failed to update settings:', error)
    })
  }

  const onToggleEnabled = (): void => {
    writeImmediateConfig({ enabled: !config.enabled })
  }

  const onCustomCommandChange = (value: string): void => {
    writeImmediateConfig({ customAgentCommand: value })
  }

  const onPrDefaultChange = (
    key: keyof NonNullable<SourceControlAiSettings['prCreationDefaults']>,
    value: boolean
  ): void => {
    writeImmediateConfig((current) => ({
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
      title: t(
        'auto.components.settings.CommitMessageAiPane.d5b45a3628',
        'Show Source Control AI actions'
      ),
      description: t(
        'auto.components.settings.CommitMessageAiPane.7bcad2b200',
        'Adds action recipes for Source Control commit, pull request, branch-name, and fix actions.'
      ),
      keywords: [
        t('auto.components.settings.CommitMessageAiPane.0b7eafe55f', 'ai'),
        t('auto.components.settings.CommitMessageAiPane.ca433708cb', 'commit'),
        t('auto.components.settings.CommitMessageAiPane.8cd2be0948', 'message'),
        t('auto.components.settings.CommitMessageAiPane.34d0348e34', 'generate'),
        t('auto.components.settings.CommitMessageAiPane.4ec89c319e', 'agent'),
        t('auto.components.settings.CommitMessageAiPane.d54c64163d', 'enabled')
      ]
    })
  ) {
    sections.push(
      <SearchableSetting
        key="enabled"
        title={t(
          'auto.components.settings.CommitMessageAiPane.d5b45a3628',
          'Show Source Control AI actions'
        )}
        description={t(
          'auto.components.settings.CommitMessageAiPane.7bcad2b200',
          'Adds action recipes for Source Control commit, pull request, branch-name, and fix actions.'
        )}
        keywords={['ai', 'commit', 'message', 'generate', 'agent', 'enabled']}
        className="flex items-center justify-between gap-4 py-3"
      >
        <div className="space-y-1">
          <Label>
            {t(
              'auto.components.settings.CommitMessageAiPane.d5b45a3628',
              'Show Source Control AI actions'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.CommitMessageAiPane.2339a89104',
              'Adds AI buttons that run the selected agent with the command template for that action.'
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            'auto.components.settings.CommitMessageAiPane.d5b45a3628',
            'Show Source Control AI actions'
          )}
          checked={config.enabled}
          onCheckedChange={onToggleEnabled}
        />
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
        title: t('auto.components.settings.CommitMessageAiPane.47e45cbd5a', 'Custom command'),
        description: t(
          'auto.components.settings.CommitMessageAiPane.1ef29f8c29',
          'Command line Orca runs when a text recipe uses Custom command.'
        ),
        keywords: [
          t('auto.components.settings.CommitMessageAiPane.25350d670f', 'custom'),
          t('auto.components.settings.CommitMessageAiPane.54038660e0', 'command'),
          t('auto.components.settings.CommitMessageAiPane.407d28bde6', 'cli'),
          t('auto.components.settings.CommitMessageAiPane.1df7d71313', 'binary'),
          t('auto.components.settings.CommitMessageAiPane.a69e1fe91a', 'prompt'),
          t('auto.components.settings.CommitMessageAiPane.fc1a525fa5', 'placeholder')
        ]
      }))
  ) {
    sections.push(
      <SearchableSetting
        key="custom-command"
        title={t('auto.components.settings.CommitMessageAiPane.47e45cbd5a', 'Custom command')}
        description={t(
          'auto.components.settings.CommitMessageAiPane.1ef29f8c29',
          'Command line Orca runs when a text recipe uses Custom command.'
        )}
        keywords={['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']}
        className="space-y-2 py-3"
      >
        <CustomAgentCommandField
          id="source-control-ai-custom-command"
          value={config.customAgentCommand}
          onChange={onCustomCommandChange}
        />
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    matchesSettingsSearch(searchQuery, {
      title: t(
        'auto.components.settings.CommitMessageAiPane.2dafc7646e',
        'Hosted-review creation defaults'
      ),
      description: t(
        'auto.components.settings.CommitMessageAiPane.e9d46a544d',
        'Defaults used when the hosted-review composer opens.'
      ),
      keywords: [
        t('auto.components.settings.CommitMessageAiPane.19e10a12bb', 'hosted review'),
        t('auto.components.settings.CommitMessageAiPane.b388463881', 'pull request'),
        t('auto.components.settings.CommitMessageAiPane.fdee745b87', 'merge request'),
        t('auto.components.settings.CommitMessageAiPane.02bab6542c', 'pr'),
        t('auto.components.settings.CommitMessageAiPane.ebed4d2a29', 'draft'),
        t('auto.components.settings.CommitMessageAiPane.6c84ba6de3', 'template'),
        t('auto.components.settings.CommitMessageAiPane.34d0348e34', 'generate'),
        t('auto.components.settings.CommitMessageAiPane.2c5436c018', 'open')
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
    <div id="source-control-ai-settings" data-settings-section="source-control-ai-settings">
      <SettingsGroup
        title={t(
          'auto.components.settings.CommitMessageAiPane.ad66ff886d',
          'Source Control AI defaults'
        )}
        description={ownership.description}
      >
        {sections}
      </SettingsGroup>
    </div>
  )
}
