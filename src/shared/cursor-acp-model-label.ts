import type { AgentSessionModelOption } from './agent-session/agent-session-wire'
import { labelFromModelId } from './model-id-label'

// Cursor's CLI lists one row per effort and fast variant. The parameterized ACP picker uses the base id.
const CLI_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low'] as const

/** Collapse `cursor-agent models` rows onto one model per family, without effort or fast in the name. */
export function groupCursorCliModels(
  models: readonly { id: string; label: string; isDefault?: boolean }[]
): AgentSessionModelOption[] {
  const groups = new Map<string, { label: string; isDefault: boolean }>()
  for (const model of models) {
    const modelId = cursorCliBaseId(model.id)
    if (!modelId) {
      continue
    }
    const current = groups.get(modelId)
    const label = cursorCliBaseLabel(model.label, modelId)
    if (!current || label.length < current.label.length) {
      groups.set(modelId, {
        label,
        isDefault: current?.isDefault === true || model.isDefault === true
      })
    } else if (model.isDefault) {
      current.isDefault = true
    }
  }
  return [...groups].map(([id, row]) => ({
    id,
    label: row.label,
    isDefault: row.isDefault,
    efforts: []
  }))
}

function cursorCliBaseId(id: string): string | null {
  if (id === 'auto') {
    return 'default'
  }
  let rest = id.startsWith('cursor-') ? id.slice('cursor-'.length) : id
  if (rest.endsWith('-fast')) {
    rest = rest.slice(0, -'-fast'.length)
  }
  for (const level of CLI_EFFORTS) {
    const suffix = `-${level}`
    if (rest.endsWith(suffix)) {
      rest = rest.slice(0, -suffix.length)
      break
    }
  }
  return rest.length > 0 ? rest : null
}

function cursorCliBaseLabel(label: string, modelId: string): string {
  if (modelId === 'default') {
    return 'Auto'
  }
  let text = label
  let previous = ''
  while (text !== previous) {
    previous = text
    text = text.replace(/ +Fast$/i, '').replace(/ +(Low|Medium|High|Extra High|Max)$/i, '')
  }
  const stripped = text.replace(/ {2,}/g, ' ').trim()
  return stripped.length > 0 ? stripped : labelFromModelId(modelId)
}
