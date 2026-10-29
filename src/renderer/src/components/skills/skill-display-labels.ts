import type { SkillSourceKind } from '../../../../shared/skills'
import { translate } from '@/i18n/i18n'

// Repo-scoped roots also include folder workspaces; call them Workspace consistently with eligibility copy.
export function sourceKindLabel(kind: SkillSourceKind): string {
  switch (kind) {
    case 'home':
      return translate('auto.components.skills.sourceKind.home', 'Home')
    case 'repo':
      return translate('auto.components.skills.sourceKind.workspace', 'Workspace')
    case 'bundled':
      return translate('auto.components.skills.sourceKind.bundled', 'Bundled')
    case 'plugin':
      return translate('auto.components.skills.sourceKind.plugin', 'Plugin')
  }
}

export function skillCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.skill_one', '{{count}} skill', { count })
    : translate('auto.components.skills.count.skill_other', '{{count}} skills', { count })
}

export function sourceCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.source_one', '{{count}} source', { count })
    : translate('auto.components.skills.count.source_other', '{{count}} sources', { count })
}

export function fileCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.file_one', '{{count}} file', { count })
    : translate('auto.components.skills.count.file_other', '{{count}} files', { count })
}

export function shareLinkCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.link_one', '{{count}} link', { count })
    : translate('auto.components.skills.count.link_other', '{{count}} links', { count })
}

export function resultCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.result_one', '{{count}} result', { count })
    : translate('auto.components.skills.count.result_other', '{{count}} results', { count })
}

export function selectedCountLabel(count: number): string {
  return translate('auto.components.skills.count.selected', '{{count}} selected', { count })
}

export function shareSelectionActionLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.share_one', 'Share {{count}} skill', { count })
    : translate('auto.components.skills.count.share_other', 'Share {{count}} skills', { count })
}

export function installSkillsActionLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.install_one', 'Install {{count}} skill', { count })
    : translate('auto.components.skills.count.install_other', 'Install {{count}} skills', { count })
}

export function retrySkillsActionLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.retry_one', 'Retry {{count}} skill', { count })
    : translate('auto.components.skills.count.retry_other', 'Retry {{count}} skills', { count })
}
