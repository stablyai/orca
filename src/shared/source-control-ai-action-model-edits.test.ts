import { expect, it } from 'vitest'
import { saveSourceControlAiActionModelChoice } from './source-control-ai-action-model-choice'
import {
  addSourceControlAiModelEdit,
  replaySourceControlAiModelEdits,
  type SourceControlAiModelEdit,
  type SourceControlAiModelEdits
} from './source-control-ai-action-model-edits'
import type { SourceControlAiModelChoice } from './source-control-ai-types'
import type { TuiAgent } from './tui-agent'

type Edit = { agentId: TuiAgent; change: SourceControlAiModelEdit }

const START: SourceControlAiModelChoice = {
  selectedModelByAgent: { codex: 'gpt-5.4', copilot: 'gpt-5.4' },
  // Only the saved choice still names this host; Save must keep covering it.
  selectedModelByAgentByHost: { 'ssh:saved-only': { codex: 'gpt-5.4' }, local: { copilot: 'x' } },
  selectedThinkingByModel: { 'gpt-5.4': 'medium' }
}
const REGISTERED = ['ssh:registered']
const DESTINATIONS = [...REGISTERED, 'ssh:saved-only']

function settingsWith(choice: SourceControlAiModelChoice | undefined) {
  return {
    sourceControlAi: { modelOverridesByOperation: choice ? { commitMessage: choice } : {} }
  } as Parameters<typeof saveSourceControlAiActionModelChoice>[0]['settings']
}

function applyInOrder(edits: readonly Edit[]): SourceControlAiModelChoice | undefined {
  return edits.reduce<SourceControlAiModelChoice | undefined>((choice, edit) => {
    const saved = saveSourceControlAiActionModelChoice({
      target: { type: 'global' },
      settings: settingsWith(choice),
      actionId: 'commitMessage',
      hostKeys: DESTINATIONS,
      ...edit
    })
    if (!('sourceControlAi' in saved)) {
      throw new Error('Expected a global save')
    }
    return saved.sourceControlAi.modelOverridesByOperation?.commitMessage
  }, START)
}

function replayReceipt(edits: readonly Edit[]): SourceControlAiModelChoice | undefined {
  const receipt = edits.reduce<SourceControlAiModelEdits>(
    (folded, edit) => addSourceControlAiModelEdit(folded, edit.agentId, edit.change),
    []
  )
  return replaySourceControlAiModelEdits({
    target: { type: 'global' },
    settings: settingsWith(START),
    actionId: 'commitMessage',
    edits: receipt,
    hostKeys: REGISTERED
  })
}

const EDITS: Edit[] = (['codex', 'copilot'] as const).flatMap((agentId) => [
  ...['gpt-5.4', 'gpt-5.5', undefined].map((value) => ({
    agentId,
    change: { field: 'model' as const, value }
  })),
  ...['gpt-5.4', 'gpt-5.5'].flatMap((modelId) =>
    ['low', 'high', undefined].map((value) => ({
      agentId,
      change: { field: 'effort' as const, modelId, value }
    }))
  )
])

function sequences(length: number): Edit[][] {
  return length
    ? sequences(length - 1).flatMap((head) => EDITS.map((edit) => [...head, edit]))
    : [[]]
}

it('saving the folded menu edits equals applying every edit in order', () => {
  // Every sequence of up to three edits, including agents sharing one model's effort.
  for (const sequence of [1, 2, 3].flatMap(sequences)) {
    expect(replayReceipt(sequence), JSON.stringify(sequence)).toEqual(applyInOrder(sequence))
  }
})
