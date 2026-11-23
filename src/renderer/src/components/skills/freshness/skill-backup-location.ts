import type { BundledSkillOpOutcome } from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { collapseHomePath } from '../../../../../shared/skills/bundled/bundled-skill-locations'
import type { BundledSkillTarget } from '@/lib/skills/runtime/bundled-skill-target'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'

/** Where Replace backups land: `remote` names the host so `~` never reads as this computer. */
export type SkillBackupHost = { kind: 'local' } | { kind: 'remote'; name: string }

export type SkillBackupLocation = {
  /** The planned host's backups root, with its home shown as `~`. */
  folder: string
  host: SkillBackupHost
}

/** The host-side folder where Replace and the executor move old copies. */
export function skillBackupDirectory(homeDirectory: string): string {
  const separator = /^[a-z]:[\\/]|^\\\\/iu.test(homeDirectory) ? '\\' : '/'
  const home = homeDirectory.replace(/[\\/]+$/u, '')
  return [home, '.agents', '.orca-skill-backups'].join(separator)
}

export function skillBackupLocation(
  homeDirectory: string,
  host: SkillBackupHost
): SkillBackupLocation {
  return { folder: collapseHomePath(skillBackupDirectory(homeDirectory), homeDirectory), host }
}

function hostFor(target: BundledSkillTarget | null | undefined, name?: string): SkillBackupHost {
  if (!target || target.kind === 'local') {
    return { kind: 'local' }
  }
  return {
    kind: 'remote',
    name: name ?? translate('auto.components.skills.host.remote', 'Connected runtime')
  }
}

function environmentName(
  environments: readonly { id: string; name: string }[],
  target: BundledSkillTarget | null | undefined
): string | undefined {
  return target?.kind === 'environment'
    ? environments.find((candidate) => candidate.id === target.environmentId)?.name
    : undefined
}

/** Read once, for a result that must keep naming the host it ran on. */
export function skillBackupHost(target: BundledSkillTarget | null | undefined): SkillBackupHost {
  return hostFor(target, environmentName(useAppStore.getState().runtimeEnvironments, target))
}

export function useSkillBackupHost(target: BundledSkillTarget | null | undefined): SkillBackupHost {
  const name = useAppStore((state) => environmentName(state.runtimeEnvironments, target))
  return hostFor(target, name)
}

/** Every backup path one install result created, in op order, without repeats. */
export function skillBackupPaths(ops: readonly BundledSkillOpOutcome[]): string[] {
  return [
    ...new Set(ops.flatMap((op) => (op.status === 'done' && op.backupPath ? [op.backupPath] : [])))
  ]
}
