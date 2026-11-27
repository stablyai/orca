import type { CommitMessageModel } from '../../../source-control/ai/generation/commit-message-agent-spec'

export const DOUBAO_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const DOUBAO_MODEL_LIST_ARGS = ['model', 'list', '--json']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDoubaoModelList(stdout: string): CommitMessageModel[] {
  let response: unknown
  try {
    response = JSON.parse(stdout)
  } catch {
    return []
  }
  const result = isRecord(response) && response.result
  if (!isRecord(result) || result.type !== 'model_list' || !Array.isArray(result.models)) {
    return []
  }
  const models = new Map<string, CommitMessageModel>()
  const rows: unknown[] = result.models
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id.trim() || models.has(row.id)) {
      continue
    }
    const efforts = row.efforts
    const levels = DOUBAO_EFFORT_LEVELS.filter(
      (level) => Array.isArray(efforts) && efforts.includes(level)
    )
    models.set(row.id, {
      id: row.id,
      label: typeof row.name === 'string' && row.name.trim() ? row.name : row.id,
      ...(row.is_default === true ? { isDefault: true } : {}),
      thinkingLevels: levels.map((id) => ({ id, label: id })),
      ...(typeof row.default_effort === 'string' && levels.includes(row.default_effort)
        ? { defaultThinkingLevel: row.default_effort }
        : {})
    })
  }
  return [...models.values()]
}
