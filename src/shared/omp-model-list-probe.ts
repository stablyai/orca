import type { CommitMessageModel } from './commit-message-agent-spec'
import { labelFromModelId } from './model-id-label'

// Why: `omp models --json` is the one machine-readable listing OMP offers; the
// default table output groups rows per provider and would need a brittle parser.
export const OMP_MODEL_LIST_ARGS = ['models', '--json']

/** The outermost JSON value on stdout, or null when none parses. */
function parseJsonObject(stdout: string): unknown {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Why: an update notice or extension warning can precede the JSON on stdout;
    // the listing itself is the outermost object.
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

/** OMP's `provider/model` selector, the id its listing and `--model` share. */
export function ompModelSelector(
  provider: string | undefined,
  model: string | undefined
): string | null {
  return provider && model ? `${provider}/${model}` : null
}

/** Parses `omp models --json`. Ids are OMP's `provider/model` selector — the form
 *  `--model` and `/model` resolve exactly, unlike a bare model id that several
 *  providers can share. */
export function parseOmpModelList(stdout: string): CommitMessageModel[] {
  const parsed = parseJsonObject(stdout)
  if (!parsed || typeof parsed !== 'object' || !('models' in parsed)) {
    return []
  }
  const rows: unknown = parsed.models
  if (!Array.isArray(rows)) {
    return []
  }
  const byId = new Map<string, CommitMessageModel>()
  for (const row of rows) {
    const value: unknown = row
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    const provider =
      'provider' in value && typeof value.provider === 'string' ? value.provider.trim() : ''
    const bareId = 'id' in value && typeof value.id === 'string' ? value.id.trim() : ''
    const selector =
      'selector' in value && typeof value.selector === 'string' ? value.selector.trim() : ''
    const id = selector || ompModelSelector(provider, bareId)
    if (!id || byId.has(id)) {
      continue
    }
    const name = 'name' in value && typeof value.name === 'string' ? value.name.trim() : ''
    const contextWindow =
      'contextWindow' in value && typeof value.contextWindow === 'number'
        ? value.contextWindow
        : null
    byId.set(id, {
      id,
      label: name || labelFromModelId(id),
      // Why: the same model name ships under several providers; the provider is
      // what tells two "DeepSeek V4 Pro" rows apart in the picker.
      ...(provider ? { description: provider } : {}),
      ...(contextWindow !== null && Number.isFinite(contextWindow) && contextWindow > 0
        ? { contextWindowTokens: contextWindow }
        : {})
    })
  }
  return [...byId.values()]
}
