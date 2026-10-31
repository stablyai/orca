import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  sourceControlActionOptions,
  sourceControlActionSelectedPreferences,
  sourceControlActionPermissionModeRoute
} from '../../../../shared/source-control-action-launch-preferences'
import { translate } from '@/i18n/i18n'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { agentPermissionChoiceLabel } from './AgentPermissionChoiceControls'
import { sourceControlActionRouteHint } from './SourceControlActionOptionField'

/** Describes the saved choices and which launches they reach. */
export function describeSourceControlActionModel(
  agent: TuiAgent,
  preferences: SourceControlActionLaunchPreferences
): string {
  preferences = sourceControlActionSelectedPreferences(
    { launchPreferences: preferences },
    agent
  ) ?? { agentId: agent }
  const { model: modelId, permissionMode } = preferences
  const catalog = getAgentSessionOptionCatalog(agent) ?? { models: [], modelApply: {} }
  const labels = [
    ...(modelId ? [findCatalogModel(catalog, modelId)?.label ?? modelId] : []),
    ...sourceControlActionOptions(agent, modelId ?? '').flatMap(({ option }) => {
      const value = preferences.options?.[option.id]
      return value && option.kind.type === 'select'
        ? [option.kind.choices.find((choice) => choice.value === value)?.label ?? value]
        : []
    })
  ]
  if (!permissionMode) {
    return translate(
      'settings.sourceControl.actionModel.savedModel',
      'Model from Settings: {{value0}}',
      { value0: labels.join(' · ') }
    )
  }
  return translate(
    'settings.sourceControl.actionModel.savedLaunchOptions',
    'Saved options: {{value0}}. Older servers use their own permission settings.',
    {
      value0: [
        ...labels,
        agentPermissionChoiceLabel(
          permissionMode,
          AGENT_CATALOG.find((entry) => entry.id === agent)?.label ?? agent
        ),
        sourceControlActionRouteHint(sourceControlActionPermissionModeRoute(agent, permissionMode))
      ]
        .filter(Boolean)
        .join(' · ')
    }
  )
}
