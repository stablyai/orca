import type { PluginHostInstallSource } from '../../../../preload/api-types'
import { isAllowedPluginGitUrl } from '../../../../shared/plugins/plugin-install-lockfile'

export type PluginInstallSourceParseResult =
  | { ok: true; source: PluginHostInstallSource }
  | {
      ok: false
      reason: 'missing-local-path' | 'missing-git-url' | 'missing-git-ref' | 'invalid-git-url'
    }

export function parsePluginInstallSource(
  kind: 'local-path' | 'git',
  input: string
): PluginInstallSourceParseResult {
  const value = input.trim()
  if (kind === 'local-path') {
    return value
      ? { ok: true, source: { kind: 'local-path', path: value } }
      : { ok: false, reason: 'missing-local-path' }
  }
  if (!value) {
    return { ok: false, reason: 'missing-git-url' }
  }
  const separatorIndex = value.lastIndexOf('#')
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return { ok: false, reason: 'missing-git-ref' }
  }
  const url = value.slice(0, separatorIndex).trim()
  const ref = value.slice(separatorIndex + 1).trim()
  if (!url) {
    return { ok: false, reason: 'missing-git-url' }
  }
  if (!isAllowedPluginGitUrl(url)) {
    return { ok: false, reason: 'invalid-git-url' }
  }
  if (!ref) {
    return { ok: false, reason: 'missing-git-ref' }
  }
  return { ok: true, source: { kind: 'git', url, ref } }
}
