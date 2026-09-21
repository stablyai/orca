import type { SkillSourceKind } from '../../../../shared/skills'
import { translate } from '@/i18n/i18n'

// Why: 'repo' roots also come from folder workspaces, so "Repository" misnames
// half of them; "Workspace" matches the share-eligibility copy users read next.
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
    ? translate('auto.components.skills.count.skillOne', '{{count}} skill', { count })
    : translate('auto.components.skills.count.skillOther', '{{count}} skills', { count })
}

export function sourceCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.sourceOne', '{{count}} source', { count })
    : translate('auto.components.skills.count.sourceOther', '{{count}} sources', { count })
}

export function fileCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.fileOne', '{{count}} file', { count })
    : translate('auto.components.skills.count.fileOther', '{{count}} files', { count })
}

export function shareLinkCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.linkOne', '{{count}} link', { count })
    : translate('auto.components.skills.count.linkOther', '{{count}} links', { count })
}

export function resultCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.resultOne', '{{count}} result', { count })
    : translate('auto.components.skills.count.resultOther', '{{count}} results', { count })
}

export function selectedCountLabel(count: number): string {
  return translate('auto.components.skills.count.selected', '{{count}} selected', { count })
}

export function shareSelectionActionLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.shareOne', 'Share {{count}} skill', { count })
    : translate('auto.components.skills.count.shareOther', 'Share {{count}} skills', { count })
}

export function installSkillsActionLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.installOne', 'Install {{count}} skill', { count })
    : translate('auto.components.skills.count.installOther', 'Install {{count}} skills', { count })
}

export function retrySkillsActionLabel(count: number): string {
  return count === 1
    ? translate('auto.components.skills.count.retryOne', 'Retry {{count}} skill', { count })
    : translate('auto.components.skills.count.retryOther', 'Retry {{count}} skills', { count })
}
