import type { OrcaHooks } from './orca-yaml-hook-types'

/**
 * Trust content for the committed setup + default-tab launch surface.
 *
 * Main and renderer both gate on this; they must hash the same bytes or a
 * change trusted in one is silently accepted by the other.
 *
 * The format is unambiguous by indentation: structural lines are machine-built
 * and live at column 0 (`# …`) or one indent (`  env KEY=value`), while every
 * byte of user free text — setup scripts, tab commands — is emitted at two
 * indents. Free text therefore cannot forge a header or an env line, which it
 * could when commands were interpolated raw: a `command:` whose first line read
 * `NODE_OPTIONS=…` used to hash identically to a real `env:` entry, and only the
 * latter actually exports the variable into the spawned PTY.
 */
const STRUCTURAL_INDENT = '  '
const FREE_TEXT_INDENT = '    '

function indentFreeText(value: string): string {
  return value
    .split('\n')
    .map((line) => `${FREE_TEXT_INDENT}${line}`)
    .join('\n')
}

export function getDefaultTabCommandTrustContent(hooks: OrcaHooks | null): string {
  const blocks: string[] = []

  const setup = hooks?.scripts?.setup?.trim()
  if (setup) {
    blocks.push(`# setup\n${indentFreeText(setup)}`)
  }

  ;(hooks?.defaultTabs ?? []).forEach((tab, index) => {
    const command = tab.command?.trim()
    // Why: committed env is trust-relevant too — it can redirect binaries (PATH) or pull 1Password secrets (op:// refs).
    // Sorted so re-ordering keys in orca.yaml, which changes nothing semantically, does not re-prompt.
    // Keys are [A-Za-z_][A-Za-z0-9_]* and values are control-char-free (orca-yaml.ts), so each line stays single-line.
    const envLines = Object.entries(tab.env ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${STRUCTURAL_INDENT}env ${key}=${value}`)
    if (!command && envLines.length === 0) {
      return
    }
    // Why: escape here, not at parse time. A remote host on an older build parses a
    // newline-bearing title happily and the client trusts its already-parsed hooks
    // without revalidating, so `title: "A\n    x\n\n# defaultTabs[2] B"` would forge a
    // second block. Escaping in the serializer holds regardless of which build parsed it.
    const label = tab.title ? ` ${JSON.stringify(tab.title)}` : ''
    const body = [...envLines, ...(command ? [indentFreeText(command)] : [])].join('\n')
    blocks.push(`# defaultTabs[${index + 1}]${label}\n${body}`)
  })

  return blocks.join('\n\n')
}
