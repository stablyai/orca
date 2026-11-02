import type { CommitMessageModel } from './commit-message-agent-spec'
import { labelFromModelId } from './model-id-label'

// grok models exposes only human-readable text, with no --json/--format.
export const GROK_MODEL_LIST_ARGS = ['models']

const AVAILABLE_MODELS_HEADER = 'Available models:'
// Default rows use *, others -; star-only parsing silently drops non-default models.
const MODEL_BULLET = /^\s*[*-]\s+([^\s(]+)(.*)$/
// Read markers from listed rows so preamble defaults cannot name unavailable IDs.
const DEFAULT_MARKER = /\(default\)/

export function parseGrokModelList(stdout: string): CommitMessageModel[] {
  const lines = stdout.split(/\r?\n/)
  // Require the header to exclude default/login preambles that resemble model IDs.
  const headerIndex = lines.findIndex((line) => line.trim() === AVAILABLE_MODELS_HEADER)
  if (headerIndex === -1) {
    return []
  }
  const byId = new Map<string, CommitMessageModel>()
  for (const line of lines.slice(headerIndex + 1)) {
    // Blank lines end sections; footer hints must not become launchable IDs.
    if (line.trim() === '' && byId.size > 0) {
      break
    }
    const match = MODEL_BULLET.exec(line)
    const id = match?.[1]
    if (!id) {
      continue
    }
    const model = byId.get(id) ?? { id, label: labelFromModelId(id) }
    // A repeat row still carries the marker's news, even though the id is not new.
    if (DEFAULT_MARKER.test(match[2])) {
      model.isDefault = true
    }
    byId.set(id, model)
  }
  return [...byId.values()]
}
