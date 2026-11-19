import type { OrcaHooks } from '../../../../../shared/workspace-setup/orca-yaml-hook-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { boundHostList } from '@/components/host-picker/bounded-host-list'

export type EphemeralVmRecipeOption = NonNullable<OrcaHooks['environmentRecipes']>[number]

export const RUN_TARGET_ADD_HOST_KEY = 'add-host'
export const RUN_TARGET_RECIPES_KEY = 'per-workspace-env'

export type RunTargetHostOption = {
  id: string
  hostId: ExecutionHostId
  label: string
  detail: string
  description?: string
  searchText?: string
  available: boolean
  /** Holds the host's position while a connection changes its availability. */
  group?: 'ready' | 'unavailable'
  icon?: React.ReactNode
  trailing?: (select: () => void) => React.ReactNode
  onSelect?: () => void
  keepOpen?: boolean
}

/** A row in the run-target list. Hosts commit; the last two open a submenu. */
export type RunTargetRowModel =
  | { key: string; kind: 'host'; option: RunTargetHostOption }
  | { key: typeof RUN_TARGET_RECIPES_KEY; kind: 'recipes' }
  | { key: typeof RUN_TARGET_ADD_HOST_KEY; kind: 'add-host' }

export function getEphemeralVmLabel(t: Translate = translate): string {
  return t('auto.components.NewWorkspaceComposerCard.ephemeralVm', 'Per-Workspace Environment')
}

export function getRecipeCommandDisplay(command: string): string {
  const trimmed = command.trim()
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/)
  return quoted?.[1] ?? trimmed.split(/\s+/)[0] ?? trimmed
}

export function getRecipeDestroyLabel(
  recipe: EphemeralVmRecipeOption,
  t: Translate = translate
): string {
  if (recipe.destroyDisabled) {
    return t('auto.components.NewWorkspaceComposerCard.destroyDisabled', 'destroy disabled')
  }
  if (recipe.destroy) {
    return t('auto.components.NewWorkspaceComposerCard.destroyConfigured', 'destroy configured')
  }
  return t('auto.components.NewWorkspaceComposerCard.noDestroyConfigured', 'no destroy')
}

export function getRecipeDetail(recipe: EphemeralVmRecipeOption, t?: Translate): string {
  return `${getRecipeCommandDisplay(recipe.create)} · ${getRecipeDestroyLabel(recipe, t)}`
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query)
}

/** Show ready hosts first; bound and rank unready hosts, which may include every configured SSH host. */
function buildHostRows(
  hostOptions: readonly RunTargetHostOption[],
  query: string
): { rows: RunTargetRowModel[]; hiddenHostCount: number } {
  const hostMatches = (option: RunTargetHostOption): boolean =>
    query === '' ||
    matches(option.label, query) ||
    matches(option.detail, query) ||
    matches(option.searchText ?? option.description ?? '', query)

  const isReadyGroup = (option: RunTargetHostOption): boolean =>
    option.group ? option.group === 'ready' : option.available
  const ready = hostOptions.filter((option) => isReadyGroup(option) && hostMatches(option))
  const needsSetup = boundHostList(
    hostOptions
      .filter((option) => !isReadyGroup(option) && hostMatches(option))
      .map((option) => ({
        id: option.id,
        label: option.label,
        searchText: `${option.detail}\n${option.searchText ?? option.description ?? ''}`,
        option
      })),
    // Why the query again: ranks an exact name first so typing it always reaches the host.
    { query }
  )
  const rows: RunTargetRowModel[] = [...ready, ...needsSetup.shown.map(({ option }) => option)].map(
    (option) => ({ key: `host:${option.id}`, kind: 'host', option })
  )
  return { rows, hiddenHostCount: needsSetup.hiddenCount }
}

function matchRecipes(
  recipes: readonly EphemeralVmRecipeOption[],
  query: string,
  t?: Translate
): EphemeralVmRecipeOption[] {
  return recipes.filter(
    (recipe) =>
      query === '' ||
      matches(recipe.name, query) ||
      matches(getEphemeralVmLabel(t), query) ||
      matches(recipe.description ?? '', query)
  )
}

function buildSubmenuRows(hasRecipes: boolean, hasAddHost: boolean): RunTargetRowModel[] {
  const rows: RunTargetRowModel[] = []
  if (hasRecipes) {
    rows.push({ key: RUN_TARGET_RECIPES_KEY, kind: 'recipes' })
  }
  if (hasAddHost) {
    rows.push({ key: RUN_TARGET_ADD_HOST_KEY, kind: 'add-host' })
  }
  return rows
}

/** Filter host/recipe rows but always keep Add host reachable; other submenus require matching contents. */
export function buildRunTargetRows(
  {
    hostOptions,
    recipes,
    query,
    hasAddHost
  }: {
    hostOptions: readonly RunTargetHostOption[]
    recipes: readonly EphemeralVmRecipeOption[]
    query: string
    hasAddHost: boolean
  },
  t?: Translate
): {
  rows: RunTargetRowModel[]
  matchedRecipes: EphemeralVmRecipeOption[]
  /** Hosts the row limit left out; typing narrows them in. */
  hiddenHostCount: number
} {
  const trimmed = query.trim().toLowerCase()
  const matchedRecipes = matchRecipes(recipes, trimmed, t)
  const hostRows = buildHostRows(hostOptions, trimmed)
  const rows: RunTargetRowModel[] = [
    ...hostRows.rows,
    ...buildSubmenuRows(matchedRecipes.length > 0, hasAddHost)
  ]
  return { rows, matchedRecipes, hiddenHostCount: hostRows.hiddenHostCount }
}
