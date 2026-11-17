// Cloud workspace sentences that name the workspace. A workspace with no name gets its own sentence
// ("Couldn’t wake this workspace"), never "This workspace" spliced into the middle of a template.
import type { Translate } from '@/i18n/use-translate'

/** A heading or title for the workspace: its name, else "Cloud workspace". */
export function cloudWorkspaceTitle(name: string | null | undefined, t: Translate): string {
  return name || t('orcaCloudWorkspace.cloudWorkspaceTitle', 'Cloud workspace')
}

export function cloudWakeFailedTitle(name: string | null | undefined, t: Translate): string {
  return name
    ? t('orcaCloudWorkspace.overlay.failedTitle', 'Couldn’t wake {{name}}', { name })
    : t('orcaCloudWorkspace.overlay.failedTitleUnnamed', 'Couldn’t wake this workspace')
}

export type CloudWorkspacePhaseAnnouncement =
  | 'waking'
  | 'restarting'
  | 'unarchiving'
  | 'archived'
  | 'asleep'

/** Screen-reader line for a phase change. */
export function cloudWorkspaceAnnouncement(
  kind: CloudWorkspacePhaseAnnouncement,
  name: string | null | undefined,
  t: Translate
): string {
  if (name) {
    switch (kind) {
      case 'waking':
        return t('orcaCloudWorkspace.announce.waking', 'Waking {{name}}.', { name })
      case 'restarting':
        return t('orcaCloudWorkspace.announce.restarting', 'Restarting {{name}}.', { name })
      case 'unarchiving':
        return t('orcaCloudWorkspace.announce.unarchivingNamed', 'Unarchiving {{name}}.', { name })
      case 'archived':
        return t('orcaCloudWorkspace.announce.archived', '{{name}} is archived.', { name })
      case 'asleep':
        return t('orcaCloudWorkspace.announce.asleep', '{{name}} is asleep.', { name })
    }
  }
  switch (kind) {
    case 'waking':
      return t('orcaCloudWorkspace.announce.wakingUnnamed', 'Waking this workspace.')
    case 'restarting':
      return t('orcaCloudWorkspace.announce.restartingUnnamed', 'Restarting this workspace.')
    case 'unarchiving':
      return t('orcaCloudWorkspace.announce.unarchivingUnnamed', 'Unarchiving this workspace.')
    case 'archived':
      return t('orcaCloudWorkspace.announce.archivedUnnamed', 'This workspace is archived.')
    case 'asleep':
      return t('orcaCloudWorkspace.announce.asleepUnnamed', 'This workspace is asleep.')
  }
}
