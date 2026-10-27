// Bound flat command rows, prefixing child commands with their agent label because no parent row supplies that context.

const MAX_DESCRIPTION_CHARS = 512

/** Reserve label space so a long label cannot consume the command it qualifies. */
const MAX_LABEL_CHARS = 96

/** Never split surrogate pairs: non-JSON UTF-8 hops lose lone surrogates, including after the composed row’s second clip. */
function boundText(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  const keep = max - 1
  const last = value.charCodeAt(keep - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep
  return `${value.slice(0, end)}…`
}

export function boundCodexCommandDescription(command: string): string {
  return boundText(command, MAX_DESCRIPTION_CHARS)
}

export function codexChildCommandDescription(
  label: string,
  description: string | undefined
): string {
  const name = boundText(label, MAX_LABEL_CHARS)
  return boundText(description ? `${name} — ${description}` : name, MAX_DESCRIPTION_CHARS)
}
