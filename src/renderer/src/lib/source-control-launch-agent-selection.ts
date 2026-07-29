import { getAgentCatalog } from '@/lib/agent-catalog'
import { isCustomAgentId } from '../../../shared/commit-message-agent-spec'
import {
  normalizeRepoSourceControlAiOverrides,
  resolveSourceControlActionRecipe
} from '../../../shared/source-control-ai'
import type {
  SourceControlActionId,
  SourceControlActionRecipe
} from '../../../shared/source-control-ai-actions'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import type { GlobalSettings, Repo, TuiAgent } from '../../../shared/types'

export function readSourceControlLaunchRecipeAgentId(
  recipe: Pick<SourceControlActionRecipe, 'agentId'> | null | undefined
): TuiAgent | null {
  const agentId = recipe?.agentId
  return agentId && !isCustomAgentId(agentId) ? agentId : null
}

export function pickSourceControlLaunchAgent(args: {
  savedAgent?: TuiAgent | null
  defaultAgent: TuiAgent | 'blank' | null | undefined
  detectedAgents: TuiAgent[]
  disabledAgents?: TuiAgent[]
}): TuiAgent | null {
  const enabledAgents = filterEnabledTuiAgents(args.detectedAgents, args.disabledAgents)
  if (args.savedAgent && enabledAgents.includes(args.savedAgent)) {
    return args.savedAgent
  }
  if (
    args.defaultAgent &&
    args.defaultAgent !== 'blank' &&
    enabledAgents.includes(args.defaultAgent)
  ) {
    return args.defaultAgent
  }
  return getAgentCatalog().find((entry) => enabledAgents.includes(entry.id))?.id ?? null
}

export type SourceControlLaunchAgentScope = {
  /** Agent the button would launch, after applying any repo override. */
  effectiveAgentId: TuiAgent | null
  /** Agent the button would launch without a repo override (global recipe or default). */
  globalAgentId: TuiAgent | null
  /**
   * True when this repo pins a different launch agent than the global default —
   * the silent-override case we surface instead of auto-launching blindly.
   */
  overridesGlobalAgent: boolean
}

export function resolveSourceControlLaunchAgentScope(input: {
  settings:
    | Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent'>
    | null
    | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
  actionId: SourceControlActionId
}): SourceControlLaunchAgentScope {
  const effectiveAgentId = readSourceControlLaunchRecipeAgentId(
    resolveSourceControlActionRecipe({
      settings: input.settings,
      repo: input.repo,
      actionId: input.actionId
    })
  )
  const globalRecipeAgentId = readSourceControlLaunchRecipeAgentId(
    resolveSourceControlActionRecipe({
      settings: input.settings,
      repo: null,
      actionId: input.actionId
    })
  )
  // Why: the note compares against what would run with no override, so fall back
  // to the global default agent when no global recipe agent is set.
  const defaultTuiAgent = input.settings?.defaultTuiAgent
  const globalAgentId =
    globalRecipeAgentId ?? (defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : null)
  const hasRepoAgentOverride =
    normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)?.actionOverrides?.[
      input.actionId
    ]?.agentId !== undefined
  return {
    effectiveAgentId,
    globalAgentId,
    overridesGlobalAgent:
      hasRepoAgentOverride && effectiveAgentId !== null && effectiveAgentId !== globalAgentId
  }
}

export type SourceControlActionRecipeOverrideField = 'agent' | 'commandTemplate' | 'agentArgs'

export type SourceControlActionRecipeOverride = {
  repoId: string
  repoName: string
  fields: SourceControlActionRecipeOverrideField[]
}

export type SourceControlActionRecipeOverrideSummary = {
  count: number
  overrides: SourceControlActionRecipeOverride[]
}

type NormalizedRepoSourceControlAiOverrides = NonNullable<
  ReturnType<typeof normalizeRepoSourceControlAiOverrides>
>

function hasActionOverride(
  overrides: NormalizedRepoSourceControlAiOverrides['actionOverrides'] | undefined,
  actionId: SourceControlActionId
): boolean {
  return Object.prototype.hasOwnProperty.call(overrides ?? {}, actionId)
}

function readRecipeOverrideFields(
  recipe:
    | NonNullable<NormalizedRepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
    | null
    | undefined
): SourceControlActionRecipeOverrideField[] {
  const fields: SourceControlActionRecipeOverrideField[] = []
  if (Object.prototype.hasOwnProperty.call(recipe ?? {}, 'agentId')) {
    fields.push('agent')
  }
  if (Object.prototype.hasOwnProperty.call(recipe ?? {}, 'commandInputTemplate')) {
    fields.push('commandTemplate')
  }
  if (Object.prototype.hasOwnProperty.call(recipe ?? {}, 'agentArgs')) {
    fields.push('agentArgs')
  }
  return fields
}

/**
 * Which repos own any recipe setting for an action — lets the global recipe
 * editor warn that saving globally will not update those repo-specific recipes.
 */
export function summarizeReposOverridingActionRecipe(input: {
  repos: readonly Pick<Repo, 'id' | 'displayName' | 'sourceControlAi'>[]
  actionId: SourceControlActionId
}): SourceControlActionRecipeOverrideSummary {
  const overrides: SourceControlActionRecipeOverride[] = []
  for (const repo of input.repos) {
    const actionOverrides = normalizeRepoSourceControlAiOverrides(
      repo.sourceControlAi
    )?.actionOverrides
    if (!hasActionOverride(actionOverrides, input.actionId)) {
      continue
    }
    overrides.push({
      repoId: repo.id,
      repoName: repo.displayName,
      fields: readRecipeOverrideFields(actionOverrides?.[input.actionId])
    })
  }
  return { count: overrides.length, overrides }
}
