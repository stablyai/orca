import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import {
  readSourceControlActionDefault,
  resolveSourceControlActionCommandTemplate,
  type SourceControlActionId,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import { commandTemplateFromOperationInstruction } from './source-control-ai-command-template'
import { normalizeRepoSourceControlAiOverrides } from './source-control-ai-repo-settings'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  normalizeSourceControlAiSettings
} from './source-control-ai-settings'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiOperation,
  SourceControlAiPrCreationDefaults,
  SourceControlAiSettings
} from './source-control-ai-types'
import type { CustomAgentId } from './commit-message-agent-spec'
import type { TuiAgent } from './tui-agent'

function readRepoInstructionOverride(
  instructions: RepoSourceControlAiOverrides['instructionsByOperation'],
  operation: SourceControlAiOperation
): string | undefined {
  if (!Object.hasOwn(instructions ?? {}, operation)) {
    return undefined
  }
  const instruction = instructions?.[operation]
  return typeof instruction === 'string' ? instruction : undefined
}

export function resolveInstructionsFromNormalized(
  source: SourceControlAiSettings,
  repoOverrides: RepoSourceControlAiOverrides | null | undefined,
  operation: SourceControlAiOperation,
  legacyCustomPrompt: string | undefined
): string {
  const repoInstruction = readRepoInstructionOverride(
    repoOverrides?.instructionsByOperation,
    operation
  )
  if (repoInstruction !== undefined) {
    return repoInstruction.trim()
  }
  const globalInstruction = source.instructionsByOperation[operation]
  if (typeof globalInstruction === 'string') {
    return globalInstruction.trim()
  }
  return operation === 'commitMessage' ? (legacyCustomPrompt ?? '').trim() : ''
}

export function resolveSourceControlAiInstructions(args: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
}): string {
  const source = normalizeSourceControlAiSettings(
    args.settings.sourceControlAi,
    args.settings.commitMessageAi
  )
  return resolveInstructionsFromNormalized(
    source,
    normalizeRepoSourceControlAiOverrides(args.repo?.sourceControlAi),
    args.operation,
    args.settings.commitMessageAi?.customPrompt
  )
}

export function hasConfiguredSourceControlAiInstructions(args: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
}): boolean {
  const repoInstruction = readRepoInstructionOverride(
    normalizeRepoSourceControlAiOverrides(args.repo?.sourceControlAi)?.instructionsByOperation,
    args.operation
  )
  return repoInstruction !== undefined || resolveSourceControlAiInstructions(args).length > 0
}

export function resolvePrCreationDefaults(
  source: SourceControlAiSettings,
  repoOverrides: RepoSourceControlAiOverrides | null | undefined,
  productDefaults: SourceControlAiPrCreationDefaults | undefined
): Required<SourceControlAiPrCreationDefaults> {
  const base = {
    ...DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
    ...productDefaults,
    ...source.prCreationDefaults
  }
  const repoDefaults = repoOverrides?.prCreationDefaults
  return repoDefaults
    ? {
        draft: repoDefaults.draft ?? base.draft,
        useTemplate: repoDefaults.useTemplate ?? base.useTemplate,
        generateDetailsOnOpen: repoDefaults.generateDetailsOnOpen ?? base.generateDetailsOnOpen,
        openAfterCreate: repoDefaults.openAfterCreate ?? base.openAfterCreate
      }
    : base
}

export function resolveActionRecipeForTextOperation(
  source: SourceControlAiSettings,
  repoOverrides: RepoSourceControlAiOverrides | null | undefined,
  operation: SourceControlAiOperation
): { agentId?: TuiAgent | CustomAgentId | null; commandInputTemplate: string; agentArgs?: string } {
  const globalRecipe = readSourceControlActionDefault(source.actions, operation)
  const repoRecipe = repoOverrides?.actionOverrides?.[operation]
  const repoInstruction = readRepoInstructionOverride(
    repoOverrides?.instructionsByOperation,
    operation
  )
  const fallbackTemplate =
    repoInstruction !== undefined
      ? commandTemplateFromOperationInstruction(operation, repoInstruction)
      : resolveSourceControlActionCommandTemplate(source.actions, operation)
  const repoTemplate =
    typeof repoRecipe?.commandInputTemplate === 'string'
      ? repoRecipe.commandInputTemplate.trim()
      : undefined
  const repoAgentArgs =
    typeof repoRecipe?.agentArgs === 'string'
      ? repoRecipe.agentArgs.trim()
      : repoRecipe?.agentArgs === null
        ? ''
        : undefined
  return {
    ...(repoRecipe?.agentId !== undefined
      ? { agentId: repoRecipe.agentId }
      : globalRecipe.agentId !== undefined
        ? { agentId: globalRecipe.agentId }
        : {}),
    ...(repoAgentArgs !== undefined
      ? { agentArgs: repoAgentArgs }
      : globalRecipe.agentArgs !== undefined
        ? { agentArgs: globalRecipe.agentArgs }
        : {}),
    commandInputTemplate:
      repoTemplate !== undefined
        ? repoTemplate
        : globalRecipe.commandInputTemplate !== undefined
          ? globalRecipe.commandInputTemplate
          : fallbackTemplate
  }
}

export function resolveSourceControlAiPrCreationDefaults(input: {
  settings: Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}): Required<SourceControlAiPrCreationDefaults> {
  const source = normalizeSourceControlAiSettings(
    input.settings.sourceControlAi,
    input.settings.commitMessageAi
  )
  return resolvePrCreationDefaults(
    source,
    normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi),
    input.prCreationProductDefaults
  )
}

export function resolveSourceControlAiEnabled(input: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
}): boolean {
  const source = normalizeSourceControlAiSettings(
    input.settings?.sourceControlAi,
    input.settings?.commitMessageAi
  )
  return (
    normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)?.enabled ?? source.enabled
  )
}

export function resolveSourceControlActionRecipe(input: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
  actionId: SourceControlActionId
}): SourceControlActionRecipe {
  const source = normalizeSourceControlAiSettings(
    input.settings?.sourceControlAi,
    input.settings?.commitMessageAi
  )
  const globalRecipe = readSourceControlActionDefault(source.actions, input.actionId)
  const repoRecipe = normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)
    ?.actionOverrides?.[input.actionId]
  const commandInputTemplate = resolveSourceControlActionCommandTemplate(
    source.actions,
    input.actionId
  )
  return repoRecipe
    ? {
        ...globalRecipe,
        commandInputTemplate,
        ...(repoRecipe.agentId !== undefined ? { agentId: repoRecipe.agentId } : {}),
        ...(typeof repoRecipe.commandInputTemplate === 'string'
          ? { commandInputTemplate: repoRecipe.commandInputTemplate.trim() }
          : {}),
        ...(typeof repoRecipe.agentArgs === 'string'
          ? { agentArgs: repoRecipe.agentArgs.trim() }
          : repoRecipe.agentArgs === null
            ? { agentArgs: '' }
            : {})
      }
    : { ...globalRecipe, commandInputTemplate }
}
