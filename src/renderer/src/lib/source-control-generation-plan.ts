import { planCommitMessageGeneration } from '../../../shared/commit-message-plan'
import {
  renderSourceControlActionCommandTemplate,
  type SourceControlTextActionId
} from '../../../shared/source-control-ai-actions'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control-ai'
import { translate } from '@/i18n/i18n'

export type SourceControlGenerationPlanResult =
  | { ok: true; commandLabel: string; delivery: string; caveat: string }
  | { ok: false; error: string }

const SYNTHETIC_COMMIT_PROMPT =
  'Generate a concise git commit message for a synthetic dry-run diff. Return only the commit message.'
const SYNTHETIC_PULL_REQUEST_PROMPT =
  'Generate a hosted review title and description for a synthetic branch diff. Return structured pull request fields.'

const SYNTHETIC_TEXT_GENERATION_CONTEXT: Record<
  SourceControlTextActionId,
  Record<string, string>
> = {
  commitMessage: {
    basePrompt: SYNTHETIC_COMMIT_PROMPT,
    branch: 'feature/example',
    stagedFiles: 'M src/example.ts',
    stagedPatch: 'diff --git a/src/example.ts b/src/example.ts'
  },
  pullRequest: {
    basePrompt: SYNTHETIC_PULL_REQUEST_PROMPT,
    branch: 'feature/example',
    baseBranch: 'main',
    currentTitle: 'Draft title',
    currentBody: 'Draft description',
    commitSummary: 'a1b2c3d Add source-control AI recipes',
    changedFiles: 'src/example.ts | 12 ++++++++++--',
    patch: 'diff --git a/src/example.ts b/src/example.ts'
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

export function planSourceControlTextGeneration(
  actionId: SourceControlTextActionId,
  params: ResolvedSourceControlAiGenerationParams
): SourceControlGenerationPlanResult {
  const prompt =
    params.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(
          params.commandInputTemplate,
          SYNTHETIC_TEXT_GENERATION_CONTEXT[actionId]
        )
      : SYNTHETIC_BASE_PROMPTS[actionId]
  if (!prompt.trim()) {
    return { ok: false, error: translate("auto.lib.source.control.generation.plan.dc480d5897", "Command input is empty.") }
  }
  const planned = planCommitMessageGeneration(params, prompt)
  if (!planned.ok) {
    return { ok: false, error: planned.error }
  }
  const delivery =
    planned.plan.stdinPayload === null
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
