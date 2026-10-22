import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { translate } from '@/i18n/i18n'
import { boundHostList } from '@/components/host-picker/bounded-host-list'

export type EphemeralVmRecipeOption = NonNullable<OrcaHooks['environmentRecipes']>[number]

export const RUN_TARGET_ADD_HOST_KEY = 'add-host'
export const RUN_TARGET_RECIPES_KEY = 'per-workspace-env'

/** A row in the run-target list. Hosts commit; the last two open a submenu. */
export type RunTargetRowModel =
  | { key: string; kind: 'ready'; option: ReadyProjectHostSetupOption }
  | { key: string; kind: 'needs-setup'; option: NeedsSetupProjectHostOption }
  | { key: typeof RUN_TARGET_RECIPES_KEY; kind: 'recipes' }
  | { key: typeof RUN_TARGET_ADD_HOST_KEY; kind: 'add-host' }

export function getEphemeralVmLabel(): string {
  return translate(
    'auto.components.NewWorkspaceComposerCard.ephemeralVm',
    'Per-Workspace Environment'
  )
}

export function getRecipeCommandDisplay(command: string): string {
  const trimmed = command.trim()
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/)
  return quoted?.[1] ?? trimmed.split(/\s+/)[0] ?? trimmed
}

export function getRecipeDestroyLabel(recipe: EphemeralVmRecipeOption): string {
  if (recipe.destroyDisabled) {
    return translate('auto.components.NewWorkspaceComposerCard.destroyDisabled', 'destroy disabled')
  }
  if (recipe.destroy) {
    return translate(
      'auto.components.NewWorkspaceComposerCard.destroyConfigured',
      'destroy configured'
    )
  }
  return translate('auto.components.NewWorkspaceComposerCard.noDestroyConfigured', 'no destroy')
}

/** One line under a recipe name: what it runs and whether it tears down. */
export function getRecipeDetail(recipe: EphemeralVmRecipeOption): string {
  return `${getRecipeCommandDisplay(recipe.create)} · ${getRecipeDestroyLabel(recipe)}`
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query)
}

/**
 * Ready hosts first, then hosts that still need a connection or a project location. Ready hosts
 * already hold the project, so they are few; the rest can be every configured SSH host, so they
 * are bounded and ranked by name.
 */
function buildHostRows(
  hostOptions: readonly ProjectHostSetupOption[],
  query: string
): { rows: RunTargetRowModel[]; hiddenHostCount: number } {
  const hostMatches = (option: ProjectHostSetupOption): boolean =>
    query === '' ||
    matches(option.label, query) ||
    matches(option.detail, query) ||
    (option.kind === 'ready' && matches(option.path, query))

  const ready = hostOptions.filter(
    (option): option is ReadyProjectHostSetupOption =>
      option.kind === 'ready' && hostMatches(option)
  )
  const needsSetup = boundHostList(
    hostOptions
      .filter(
        (option): option is NeedsSetupProjectHostOption =>
          option.kind === 'needs-setup' && hostMatches(option)
      )
      .map((option) => ({
        id: getProjectHostSetupSelectionKey(option),
        label: option.label,
        searchText: option.detail,
        option
      })),
    // Why the query again: ranks an exact name first so typing it always reaches the host.
    { query }
  )
  const rows: RunTargetRowModel[] = [
    ...ready.map((option) => ({
      key: `host:${getProjectHostSetupSelectionKey(option)}`,
      kind: 'ready' as const,
      option
    })),
    ...needsSetup.shown.map(({ id, option }) => ({
      key: `needs:${id}`,
      kind: 'needs-setup' as const,
      option
    }))
  ]
  return { rows, hiddenHostCount: needsSetup.hiddenCount }
}

function matchRecipes(
  recipes: readonly EphemeralVmRecipeOption[],
  query: string
): EphemeralVmRecipeOption[] {
  return recipes.filter(
    (recipe) =>
      query === '' ||
      matches(recipe.name, query) ||
      matches(getEphemeralVmLabel(), query) ||
      matches(recipe.description ?? '', query)
  )
}

/** The rows that open a nested list rather than committing. */
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

/**
 * Filters hosts and recipes by a typed query. The submenu rows survive filtering
 * only while they still have something to show — "Add host" always survives, so
 * it stays reachable in every state including no-matches.
 */
export function buildRunTargetRows({
  hostOptions,
  recipes,
  query,
  hasAddHost
}: {
  hostOptions: readonly ProjectHostSetupOption[]
  recipes: readonly EphemeralVmRecipeOption[]
  query: string
  hasAddHost: boolean
}): {
  rows: RunTargetRowModel[]
  matchedRecipes: EphemeralVmRecipeOption[]
  /** Hosts the row limit left out; typing narrows them in. */
  hiddenHostCount: number
} {
  const trimmed = query.trim().toLowerCase()
  const matchedRecipes = matchRecipes(recipes, trimmed)
  const hostRows = buildHostRows(hostOptions, trimmed)
  const rows: RunTargetRowModel[] = [
    ...hostRows.rows,
    ...buildSubmenuRows(matchedRecipes.length > 0, hasAddHost)
  ]
  return { rows, matchedRecipes, hiddenHostCount: hostRows.hiddenHostCount }
}
