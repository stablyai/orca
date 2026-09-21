import type { CommitMessageModel } from './commit-message-agent-spec'
import { labelFromModelId } from './model-id-label'

export const KIRO_MODEL_LIST_ARGS = ['chat', '--list-models', '--format', 'json']

function parseJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) {
      return null
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

export function parseKiroModelList(stdout: string): CommitMessageModel[] {
  const parsed = parseJsonObject(stdout)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('models' in parsed)) {
    return []
  }
  const rows: unknown = parsed.models
  if (!Array.isArray(rows)) {
    return []
  }
  const defaultModel =
    'default_model' in parsed && typeof parsed.default_model === 'string'
      ? parsed.default_model.trim()
      : ''
  const byId = new Map<string, CommitMessageModel>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue
    }
    const id = 'model_id' in row && typeof row.model_id === 'string' ? row.model_id.trim() : ''
    if (!id || byId.has(id)) {
      continue
    }
    const name =
      'model_name' in row && typeof row.model_name === 'string' ? row.model_name.trim() : ''
    const description =
      'description' in row && typeof row.description === 'string' ? row.description.trim() : ''
    byId.set(id, {
      id,
      label: id === 'auto' ? 'Auto' : labelFromModelId(name || id),
      ...(description ? { description } : {}),
      ...(id === defaultModel ? { isDefault: true } : {})
    })
  }
  return [...byId.values()]
}
