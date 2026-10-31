import {
  parsePluginGitInstallInput,
  type PluginGitInstallInput,
  type PluginGitInstallInputError
} from '../../../../../shared/plugins/installation/plugin-git-install-input'

export type PluginInstallSourceParseResult =
  | { ok: true; source: { kind: 'local-path'; path: string } }
  /** `ref` is empty when the input names no version; main picks the newest version tag. */
  | { ok: true; source: { kind: 'git' } & PluginGitInstallInput }
  | { ok: false; reason: 'missing-local-path' | PluginGitInstallInputError }

export function parsePluginInstallSource(
  kind: 'local-path' | 'git',
  input: string
): PluginInstallSourceParseResult {
  if (kind === 'local-path') {
    const path = input.trim()
    return path
      ? { ok: true, source: { kind: 'local-path', path } }
      : { ok: false, reason: 'missing-local-path' }
  }
  const parsed = parsePluginGitInstallInput(input)
  return parsed.ok
    ? { ok: true, source: { kind: 'git', url: parsed.url, ref: parsed.ref } }
    : { ok: false, reason: parsed.reason }
}
