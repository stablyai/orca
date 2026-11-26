/** The lucide icons a project can show; any other stored name is drawn as Folder. */
export const REPO_LUCIDE_ICON_NAMES = [
  'Folder',
  'Code2',
  'SquareTerminal',
  'Bot',
  'Package',
  'Database',
  'Globe',
  'Server',
  'Cpu',
  'Layers',
  'Braces',
  'Rocket',
  'Wrench',
  'Briefcase',
  'Building2',
  'Palette',
  'Gauge',
  'Sparkles',
  'Shapes',
  'Box'
] as const

export type RepoLucideIconName = (typeof REPO_LUCIDE_ICON_NAMES)[number]

const comparable = (value: string): string => value.replace(/[-_\s]/g, '').toLowerCase()

/** Accepts the catalog name in any case and lucide's kebab-case form (`square-terminal`). */
export function findRepoLucideIconName(value: string): RepoLucideIconName | null {
  const wanted = comparable(value)
  return REPO_LUCIDE_ICON_NAMES.find((name) => comparable(name) === wanted) ?? null
}
