import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import {
  CUSTOM_AGENT_ID,
  type CustomAgentId,
  getCommitMessageAgentCapability,
  isCustomAgentId,
  listCommitMessageAgentCapabilities
} from '../../../../shared/commit-message-agent-spec'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import {
  customAgentCatalogEntryById,
  mergeCustomAgentCatalogEntries
} from '@/components/agent/custom-agent-catalog-entries'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export const SOURCE_CONTROL_TEXT_ACTION_ID_SET = new Set<string>(SOURCE_CONTROL_TEXT_ACTION_IDS)
const TEXT_GENERATION_AGENT_ID_SET = new Set(
  listCommitMessageAgentCapabilities().map((capability) => capability.id)
)

export const getActionDescriptions = createLocalizedCatalog(
  (): Record<SourceControlActionId, string> => ({
    commitMessage: translate(
      'auto.components.settings.source.control.action.recipe.options.commitMessage',
      'Generate the commit message from staged changes.'
    ),
    pullRequest: translate(
      'auto.components.settings.source.control.action.recipe.options.pullRequest',
      'Generate the hosted review title and description.'
    ),
    branchName: translate(
      'auto.components.settings.source.control.action.recipe.options.branchName',
      'Rename Orca-created branches from the initial agent task.'
    ),
    fixCommitFailure: translate(
      'auto.components.settings.source.control.action.recipe.options.fixCommitFailure',
      'Start an agent when a commit hook or git commit fails.'
    ),
    fixPushFailure: translate(
      'auto.components.settings.source.control.action.recipe.options.fixPushFailure',
      'Start an agent when a pre-push hook or git push fails.'
    ),
    fixChecks: translate(
      'auto.components.settings.source.control.action.recipe.options.fixChecks',
      'Start an agent from failed hosted-review checks.'
    ),
    resolveConflicts: translate(
      'auto.components.settings.source.control.action.recipe.options.resolveConflicts',
      'Start an agent for local or hosted-review merge conflicts.'
    ),
    resolveComments: translate(
      'auto.components.settings.source.control.action.recipe.options.resolveComments',
      'Start an agent from selected unresolved PR or MR comments.'
    )
  })
)

const FALLBACK_AGENT_ARGS_PLACEHOLDER = '--model sonnet'

const AGENT_ARGS_PLACEHOLDER_OVERRIDES: Partial<Record<TuiAgent, string>> = {
  // Why: Source Control AI action prompts are short, reviewable tasks; the
  // mini Codex model is a better default hint than the frontier model.
  codex: '--model gpt-5.4-mini',
  copilot: '--model gpt-5.4-mini'
}

const MODEL_FLAG_BY_AGENT: Partial<Record<TuiAgent, string>> = {
  amp: '--mode'
}

export function getSourceControlAgentArgsPlaceholder(
  agentId: TuiAgent | CustomAgentId | null | undefined
): string {
  if (!agentId) {
    return FALLBACK_AGENT_ARGS_PLACEHOLDER
  }

  if (agentId === CUSTOM_AGENT_ID) {
    return '--flag value'
  }

  const override = AGENT_ARGS_PLACEHOLDER_OVERRIDES[agentId]
  if (override) {
    return override
  }

  const capability = getCommitMessageAgentCapability(agentId)
  if (!capability) {
    return '--model <model>'
  }

  return `${MODEL_FLAG_BY_AGENT[agentId] ?? '--model'} ${capability.defaultModelId}`
}

// Why: text-generation actions can only run agents that produce a single
// response, so restrict the picker while still surfacing an already-selected
// agent even if it is no longer a supported text generator.
export function getAgentCatalogForAction(
  actionId: SourceControlActionId,
  selectedAgent: TuiAgent | CustomAgentId | null | undefined,
  snapshot: LocalAgentCatalogSnapshot | null = null
): AgentCatalogEntry[] {
  if (!SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId)) {
    // Launch actions spawn an interactive agent, so customs are selectable here
    // exactly as they are in the source-control action dialog. Never
    // detection-gated: availability is preflighted by the host at launch.
    const options = mergeCustomAgentCatalogEntries(getAgentCatalog(), snapshot, [], null)
    if (!selectedAgent || options.some((entry) => entry.id === selectedAgent)) {
      return options
    }
    // Draft-keep: a disabled custom assignment stays visible with its real label.
    const kept = isCustomAgentId(selectedAgent)
      ? null
      : customAgentCatalogEntryById(snapshot, selectedAgent)
    return kept ? [...options, kept] : options
  }
  // Why customs are intentionally absent here (not the missing-customs picker
  // class): text-generation is a headless invocation against the per-built-in
  // spec registry, not an interactive PTY launch, so a named custom id cannot
  // resolve to a spawn command on this path — offering one would be a row that
  // silently resolves to something other than what it claims. The `selectedAgent`
  // clause is continuity-only (an already-assigned agent stays visible for
  // explicit reselection); base∈text-gen customs resolving their own config
  // headlessly would be a separate host-contract feature.
  return getAgentCatalog().filter(
    (agent) => TEXT_GENERATION_AGENT_ID_SET.has(agent.id) || agent.id === selectedAgent
  )
}

function formatSupportedAgentLabels(): string {
  return [
    ...listCommitMessageAgentCapabilities().map((capability) => capability.label),
    translate(
      'auto.components.settings.source.control.action.recipe.options.customCommand',
      'Custom command'
    )
  ].join(', ')
}

export function getSourceControlActionAgentSupportText(
  actionId: SourceControlActionId
): string | null {
  if (!SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId)) {
    return null
  }
  return translate(
    'auto.components.settings.source.control.action.recipe.options.supportedAgents',
    'Supported agents for this recipe: {{value0}}.',
    { value0: formatSupportedAgentLabels() }
  )
}

export function getSourceControlActionAgentWarningText(
  actionId: SourceControlActionId,
  selectedAgent: TuiAgent | CustomAgentId | null | undefined
): string | null {
  if (!SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId)) {
    return null
  }

  if (selectedAgent && !isCustomAgentId(selectedAgent)) {
    if (TEXT_GENERATION_AGENT_ID_SET.has(selectedAgent)) {
      return null
    }
    const agentLabel = getAgentCatalog().find((agent) => agent.id === selectedAgent)?.label
    return translate(
      'auto.components.settings.source.control.action.recipe.options.unsupportedSavedAgent',
      '{{value0}} cannot run this text-generation recipe. Pick one of the supported agents below.',
      { value0: agentLabel ?? selectedAgent }
    )
  }

  return null
}
