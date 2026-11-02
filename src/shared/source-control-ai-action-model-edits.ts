import { saveSourceControlAiActionModelChoice } from './source-control-ai-action-model-choice'
import type { SourceControlAiWriteTarget } from './source-control-ai-recipe-save'
import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { AiTextOperation, SourceControlAiModelChoice } from './source-control-ai-types'
import type { TuiAgent } from './tui-agent'

/** What a card's Model and Effort menus changed, kept in memory until Save; `null` is a clear. */
export type SourceControlAiModelEdits = readonly {
  agentId: TuiAgent
  model?: string | null
  effortByModel?: Record<string, string | null>
}[]

export type SourceControlAiModelEdit =
  | { field: 'model'; value: string | undefined }
  | { field: 'effort'; modelId: string; value: string | undefined }

/** Later edits to the same field win, as in the menu. */
export function addSourceControlAiModelEdit(
  edits: SourceControlAiModelEdits | undefined,
  agentId: TuiAgent,
  edit: SourceControlAiModelEdit
): SourceControlAiModelEdits {
  const others = (edits ?? []).filter((entry) => entry.agentId !== agentId)
  const agentEdits = { ...edits?.find((entry) => entry.agentId === agentId), agentId }
  if (edit.field === 'model') {
    agentEdits.model = edit.value ?? null
  } else {
    agentEdits.effortByModel = { ...agentEdits.effortByModel, [edit.modelId]: edit.value ?? null }
  }
  return [...others, agentEdits]
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
  for (const { agentId, ...agentEdits } of input.edits) {
    const changes: SourceControlAiModelEdit[] = [
      ...(agentEdits.model !== undefined
        ? [{ field: 'model' as const, value: agentEdits.model ?? undefined }]
        : []),
      ...Object.entries(agentEdits.effortByModel ?? {}).map(([modelId, value]) => ({
        field: 'effort' as const,
        modelId,
        value: value ?? undefined
      }))
    ]
    for (const change of changes) {
      const saved = saveSourceControlAiActionModelChoice({
        target: input.target,
        settings,
        repo,
        actionId: input.actionId,
        agentId,
        hostKeys: input.hostKeys,
        change
      })
      // Only the model map is replayed; Arguments come from the card's staged text.
      if ('sourceControlAi' in saved) {
        settings = { ...settings, sourceControlAi: saved.sourceControlAi }
      } else {
        repo = { sourceControlAi: saved.update.sourceControlAi }
      }
    }
  }
  return input.target.type === 'global'
    ? settings.sourceControlAi?.modelOverridesByOperation?.[input.actionId]
    : input.actionId === 'conversationName'
      ? undefined
      : repo?.sourceControlAi?.modelOverridesByOperation?.[input.actionId]
}
