import type { OrcaHooks } from './orca-yaml-hook-types'

/**
 * Trust content for committed setup + default-tab launch surface.
 *
 * Main and renderer both gate on this; they must hash the same bytes or a
 * change trusted in one is silently accepted by the other.
 */
export function getDefaultTabCommandTrustContent(hooks: OrcaHooks | null): string {
  const commands = (hooks?.defaultTabs ?? [])
    .map((tab, index) => {
      const command = tab.command?.trim()
      // Why: committed env is trust-relevant too — it can redirect binaries (PATH) or pull 1Password secrets (op:// refs).
      // Sorted so re-ordering keys in orca.yaml, which changes nothing semantically, does not re-prompt.
      // Keys are [A-Za-z_][A-Za-z0-9_]* and values are control-char-free (orca-yaml.ts), so each line is unambiguous.
      const envLines = Object.entries(tab.env ?? {})
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
      if (!command && envLines.length === 0) {
        return null
      }
      const label = tab.title ? ` ${tab.title}` : ''
      return `# defaultTabs[${index + 1}]${label}\n${[...envLines, command].filter(Boolean).join('\n')}`
    })
    .filter((entry): entry is string => entry !== null)
  return [hooks?.scripts?.setup?.trim(), ...commands].filter(Boolean).join('\n\n')
}
