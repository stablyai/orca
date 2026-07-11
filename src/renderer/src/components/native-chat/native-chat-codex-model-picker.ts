import type { CommitMessageModelCapability } from '../../../../shared/commit-message-agent-spec'

const HOME = '\x1b[H'
const DOWN = '\x1b[B'
const ENTER = '\r'

// Includes the composer's delayed Enter plus enough render time for a remote
// Codex TUI before the next popup keystroke is delivered.
export const CODEX_MODEL_PICKER_SETTLE_MS = 1_000

function selectAt(index: number): string {
  return `${HOME}${DOWN.repeat(Math.max(0, index))}${ENTER}`
}

/**
 * Keyboard stages for Codex's official `/model` picker. Each stage ends at a
 * popup boundary so the caller can wait for the TUI to render the next view.
 */
export function buildCodexModelPickerStages(
  models: readonly CommitMessageModelCapability[],
  modelId: string,
  effortId: string | null
): string[] | null {
  const target = models.find((model) => model.id === modelId)
  if (!target) {
    return null
  }

  const regularModels = models.filter((model) => !model.id.startsWith('codex-auto-'))
  const stages: string[] = []

  if (target.id.startsWith('codex-auto-')) {
    return null
  }

  const modelIndex = regularModels.findIndex((model) => model.id === modelId)
  if (modelIndex < 0) {
    return null
  }
  stages.push(selectAt(modelIndex))

  const efforts = target.thinkingLevels ?? []
  if (efforts.length > 1) {
    const requestedEffort = effortId ?? target.defaultThinkingLevel ?? efforts[0]?.id
    const effortIndex = efforts.findIndex((effort) => effort.id === requestedEffort)
    if (effortIndex < 0) {
      return null
    }
    stages.push(selectAt(effortIndex))
  }

  return stages
}
