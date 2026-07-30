import type { SkillSourceKind } from '../../../../shared/skills'

export const sourceLabels: Record<SkillSourceKind, string> = {
  home: 'Home',
  repo: 'Repository',
  bundled: 'Bundled',
  plugin: 'Plugin'
}

export function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}
