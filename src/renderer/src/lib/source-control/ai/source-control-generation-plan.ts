import { textGenerationErrorText } from '@/lib/text-generation/text-generation-error-copy'
import { planCommitMessageGeneration } from '../../../../../shared/source-control/ai/generation/commit-message-plan'
import {
  renderSourceControlActionCommandTemplate,
  type SourceControlTextActionId
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { isOnDeviceTextGenerationId } from '../../../../../shared/on-device-text-generation'

export type SourceControlGenerationPlanResult =
  | { ok: true; commandLabel: string; delivery: string; caveat: string }
  | { ok: false; error: string }

const SYNTHETIC_COMMIT_PROMPT =
  'Generate a concise git commit message for a synthetic dry-run diff. Return only the commit message.'
const SYNTHETIC_PULL_REQUEST_PROMPT =
  'Generate a hosted review title and description for a synthetic branch diff. Preserve any existing pull request or merge request template in the current description. Return structured pull request fields.'

const SYNTHETIC_TEXT_GENERATION_CONTEXT: Record<
  SourceControlTextActionId,
  Record<string, string>
> = {
  commitMessage: {
    basePrompt: SYNTHETIC_COMMIT_PROMPT,
    branch: 'feature/example',
    stagedFiles: 'M src/example.ts',
    stagedPatch: 'diff --git a/src/example.ts b/src/example.ts',
    linkedIssue: '123'
  },
  pullRequest: {
    basePrompt: SYNTHETIC_PULL_REQUEST_PROMPT,
    branch: 'feature/example',
    baseBranch: 'main',
    currentTitle: 'Draft title',
    currentBody: 'Draft description',
    commitSummary: 'a1b2c3d Add source-control AI recipes',
    changedFiles: 'src/example.ts | 12 ++++++++++--',
    patch: 'diff --git a/src/example.ts b/src/example.ts',
    linkedIssue: '123'
  },
  branchName: {
    basePrompt: 'Generate a git branch name for a synthetic task.',
    firstPrompt: 'Add source-control AI recipes',
    assistantMessage: 'I will inspect the Source Control UI and update the settings flow.'
  }
}

const SYNTHETIC_BASE_PROMPTS: Record<SourceControlTextActionId, string> = {
  commitMessage: SYNTHETIC_COMMIT_PROMPT,
  pullRequest: SYNTHETIC_PULL_REQUEST_PROMPT,
  branchName: 'Generate a git branch name for a synthetic task.'
}

/** Validate saved repo/global recipes against synthetic context; active linkedIssue must not disable Save/Generate for otherwise valid templates. */
export function planSourceControlTextGeneration(
  actionId: SourceControlTextActionId,
  params: ResolvedSourceControlAiGenerationParams,
  t: Translate = translate
): SourceControlGenerationPlanResult {
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(
          params.commandInputTemplate,
          SYNTHETIC_TEXT_GENERATION_CONTEXT[actionId]
        )
      : SYNTHETIC_BASE_PROMPTS[actionId]
  if (!prompt.trim()) {
    return {
      ok: false,
      error: t('auto.lib.source.control.generation.plan.dc480d5897', 'Command input is empty.')
    }
  }
  if (isOnDeviceTextGenerationId(params.agentId)) {
    return {
      ok: true,
      commandLabel: 'On-device (Apple Intelligence)',
      delivery: 'The prompt goes straight to the on-device model.',
      caveat: 'This checks Orca’s plan only. It does not prove the model is enabled on this Mac.'
    }
  }
  const { agentId, ...cliParams } = params
  const planned = planCommitMessageGeneration({ ...cliParams, agentId }, prompt)
  if (!planned.ok) {
    return { ok: false, error: textGenerationErrorText(planned) }
  }
  const delivery = planned.plan.promptFile
    ? 'Prompt is delivered as a temporary file attachment.'
    : planned.plan.stdinPayload === null
      ? 'Prompt is delivered as command arguments.'
      : 'Prompt is piped to the agent over stdin.'
  return {
    ok: true,
    commandLabel: [planned.plan.binary, ...planned.plan.args].join(' '),
    delivery,
    caveat:
      'This checks Orca’s planner only. It does not invoke the CLI, prove PATH or binary availability, or reproduce main-process Windows .cmd resolution.'
  }
}

export function planSourceControlCommitMessageGeneration(
  params: ResolvedSourceControlAiGenerationParams
): SourceControlGenerationPlanResult {
  return planSourceControlTextGeneration('commitMessage', params)
}
