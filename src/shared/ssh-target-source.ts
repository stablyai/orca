import type { SshTarget } from './ssh-types'

/** Missing source is ambiguous; recognize only the old import shape: label/configHost hold the alias, host holds resolved HostName. */
export function isLegacyConfigImportTarget(
  target: Pick<SshTarget, 'label' | 'configHost' | 'host'>
): boolean {
  const alias = target.configHost ?? target.label
  return Boolean(
    alias && target.label === alias && target.configHost === alias && target.host !== alias
  )
}

/** Whether a target came from ~/.ssh/config, by the same rule config sync uses. */
export function isSshConfigSourcedTarget(
  target: Pick<SshTarget, 'source' | 'label' | 'configHost' | 'host'>
): boolean {
  return (
    target.source === 'ssh-config' ||
    (target.source === undefined && isLegacyConfigImportTarget(target))
  )
}
