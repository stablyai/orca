// How a Codex command reads on a flat task row: bounded, and, for a child agent's command, where
// nothing nests it under its agent, as "<agent label> — <command>".

const MAX_DESCRIPTION_CHARS = 512

/** The label's reserved share of the description. Reserved, not merely capped:
 *  a label free to spend the whole budget clips away the command it qualifies,
 *  leaving a command row naming an agent and no command — the failure this
 *  qualification exists to remove, in the other direction. */
const MAX_LABEL_CHARS = 96

/** Every cut goes through here, clipped the way `boundSubagentField` clips the same provider
 *  string on the agent row: never mid surrogate pair, since a lone surrogate is lossy through any
 *  non-JSON UTF-8 hop. A composed row is cut a SECOND time, so a clip that is safe only where the
 *  label is bounded is not safe. */
function boundText(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  const keep = max - 1
  const last = value.charCodeAt(keep - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep
  return `${value.slice(0, end)}…`
}

/** A command's own description, bounded as the tracker admits it. */
export function boundCodexCommandDescription(command: string): string {
  return boundText(command, MAX_DESCRIPTION_CHARS)
}

/** Capped at the bound an admitted command description already respects. */
export function codexChildCommandDescription(
  label: string,
  description: string | undefined
): string {
  const name = boundText(label, MAX_LABEL_CHARS)
  return boundText(description ? `${name} — ${description}` : name, MAX_DESCRIPTION_CHARS)
}
