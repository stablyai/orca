import type { CommitMessageModel } from './commit-message-agent-spec'

// Why: `droid` has no `models` subcommand and no JSON listing. `droid exec --help`
// ends with a "Model details:" section enumerating exactly the models the signed-in
// account may use on this host, which is the only machine-readable surface there is.
export const DROID_MODEL_LIST_ARGS = ['exec', '--help']

const MODEL_DETAILS_HEADER = 'Model details:'

// Why anchor on the full row shape: the help text is prose, so a looser pattern
// would turn example lines and autonomy bullets into selectable models.
const MODEL_DETAIL_LINE =
  /^-\s+(?<label>.+?):\s+supports reasoning:\s+(?:yes|no);\s+supported:\s+\[[^\]]*\];\s+default:\s+\S+.*$/i

/**
 * Models Droid lists for this account, in the CLI's own order.
 *
 * The ids are the human labels: Droid's help prints labels only, and the
 * interactive CLI (which native chat drives) has no `--model` flag to send an id
 * to — the model is chosen inside Droid's own `/model` selector. Deriving slugs
 * would invent ids the CLI never publishes, so the label stays the identity.
 */
export function parseDroidModelList(stdout: string): CommitMessageModel[] {
  const lines = stdout.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.trim() === MODEL_DETAILS_HEADER)
  if (headerIndex === -1) {
    return []
  }
  const byLabel = new Map<string, CommitMessageModel>()
  for (const line of lines.slice(headerIndex + 1)) {
    const label = MODEL_DETAIL_LINE.exec(line.trim())?.groups?.label?.trim()
    if (!label || byLabel.has(label)) {
      continue
    }
    byLabel.set(label, { id: label, label })
  }
  return [...byLabel.values()]
}
