import type { CommitMessageModel } from './commit-message-agent-spec'
import { labelFromModelId } from './model-id-label'

// Why: `omp models --json` is the one machine-readable listing OMP offers; the
// default table output groups rows per provider and would need a brittle parser.
export const OMP_MODEL_LIST_ARGS = ['models', '--json']

type OmpModelRow = {
  provider?: unknown
  id?: unknown
  selector?: unknown
  name?: unknown
}

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

/** Parses `omp models --json`. Ids are OMP's `provider/model` selector — the form
 *  `--model` and `/model` resolve exactly, unlike a bare model id that several
 *  providers can share. */
export function parseOmpModelList(stdout: string): CommitMessageModel[] {
  const parsed = parseJsonObject(stdout)
  const rows = (parsed as { models?: unknown } | null)?.models
  if (!Array.isArray(rows)) {
    return []
  }
  const byId = new Map<string, CommitMessageModel>()
  for (const row of rows as OmpModelRow[]) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
    const bareId = typeof row.id === 'string' ? row.id.trim() : ''
    const selector = typeof row.selector === 'string' ? row.selector.trim() : ''
    const id = selector || (provider && bareId ? `${provider}/${bareId}` : '')
    if (!id || byId.has(id)) {
      continue
    }
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    byId.set(id, {
      id,
      label: name || labelFromModelId(id),
      // Why: the same model name ships under several providers; the provider is
      // what tells two "DeepSeek V4 Pro" rows apart in the picker.
      ...(provider ? { description: provider } : {})
    })
  }
  return [...byId.values()]
}
