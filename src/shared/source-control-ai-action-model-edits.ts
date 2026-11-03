import {
  saveSourceControlAiActionModelChoice,
  sourceControlAiModelChoiceHostKeys
} from './source-control-ai-action-model-choice'
import type { SourceControlAiWriteTarget } from './source-control-ai-recipe-save'
import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { AiTextOperation, SourceControlAiModelChoice } from './source-control-ai-types'
import type { TuiAgent } from './tui-agent'

export type SourceControlAiModelEdit =
  | { field: 'model'; value: string | undefined }
  | { field: 'effort'; modelId: string; value: string | undefined }

/** What a card's Model and Effort menus changed, in edit order, kept in memory until Save. */
export type SourceControlAiModelEdits = readonly ({
  agentId: TuiAgent
} & SourceControlAiModelEdit)[]

// The saved field an edit writes: a model per agent, an effort per model id shared by every agent.
function savedFieldKey(edit: SourceControlAiModelEdits[number]): string {
  return edit.field === 'model' ? `model ${edit.agentId}` : `effort ${edit.modelId}`
}

/** A later edit to the same saved field replaces the earlier one; the rest keep their order. */
export function addSourceControlAiModelEdit(
  edits: SourceControlAiModelEdits | undefined,
  agentId: TuiAgent,
  edit: SourceControlAiModelEdit
): SourceControlAiModelEdits {
  const next = { agentId, ...edit }
  const key = savedFieldKey(next)
  return [...(edits ?? []).filter((entry) => savedFieldKey(entry) !== key), next]
}

/** Apply the edits to the settings current at the write, covering the hosts registered then. */
export function replaySourceControlAiModelEdits(input: {
  target: SourceControlAiWriteTarget
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  actionId: AiTextOperation
  edits: SourceControlAiModelEdits
  hostKeys: readonly string[]
}): SourceControlAiModelChoice | undefined {
  let settings = input.settings
  let repo = input.repo ?? null
  // Every edit covers the same hosts, so dropping a superseded edit cannot drop a destination.
  const hostKeys = [...sourceControlAiModelChoiceHostKeys({ ...input, repo })]
  for (const edit of input.edits) {
    const saved = saveSourceControlAiActionModelChoice({
      target: input.target,
      settings,
      repo,
      actionId: input.actionId,
      agentId: edit.agentId,
      hostKeys,
      change: edit
    })
    // Only the model map is replayed; Arguments come from the card's staged text.
    if ('sourceControlAi' in saved) {
      settings = { ...settings, sourceControlAi: saved.sourceControlAi }
    } else {
      repo = { sourceControlAi: saved.update.sourceControlAi ?? undefined }
    }
  }
  return input.target.type === 'global'
    ? settings.sourceControlAi?.modelOverridesByOperation?.[input.actionId]
    : input.actionId === 'conversationName'
      ? undefined
      : repo?.sourceControlAi?.modelOverridesByOperation?.[input.actionId]
}
