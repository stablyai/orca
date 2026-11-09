import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { boundHostList } from '@/components/host-picker/bounded-host-list'

export type EphemeralVmRecipeOption = NonNullable<OrcaHooks['environmentRecipes']>[number]

export const RUN_TARGET_ADD_HOST_KEY = 'add-host'
export const RUN_TARGET_RECIPES_KEY = 'per-workspace-env'
export const RUN_TARGET_ORCA_CLOUD_KEY = 'orca-cloud'

/** Submenu item keys, used for keyboard arming and `aria-activedescendant`. */
export const RUN_TARGET_ADD_SSH_HOST_ITEM = 'add-ssh-host'
export const RUN_TARGET_ADD_REMOTE_SERVER_ITEM = 'add-remote-server'

export type RunTargetSubmenu = 'recipes' | 'add-host'

/** A row in the run-target list. Hosts and Orca Cloud commit; recipes and Add host open a submenu. */
export type RunTargetRowModel =
  | { key: string; kind: 'ready'; option: ReadyProjectHostSetupOption }
  | { key: string; kind: 'needs-setup'; option: NeedsSetupProjectHostOption }
  | {
      key: typeof RUN_TARGET_ORCA_CLOUD_KEY
      kind: 'orca-cloud'
      /** Null for the sign-in/upsell row shown before the account can use Orca Cloud. */
      recipe: EphemeralVmRecipeOption | null
    }
  | { key: typeof RUN_TARGET_RECIPES_KEY; kind: 'recipes' }
  | { key: typeof RUN_TARGET_ADD_HOST_KEY; kind: 'add-host' }

export function getEphemeralVmLabel(t: Translate = translate): string {
  return t('auto.components.NewWorkspaceComposerCard.customEnvironments', 'Custom environments')
}

export function isOrcaCloudRecipe(recipe: EphemeralVmRecipeOption): boolean {
  return recipe.provider === 'orca-cloud'
}

export function isOrcaCloudSelection({
  ephemeralVmRecipes,
  selectedEphemeralVmRecipeId
}: {
  ephemeralVmRecipes?: readonly EphemeralVmRecipeOption[]
  selectedEphemeralVmRecipeId?: string | null
}): boolean {
  const selected = ephemeralVmRecipes?.find((recipe) => recipe.id === selectedEphemeralVmRecipeId)
  return selected ? isOrcaCloudRecipe(selected) : false
}

export function getOrcaCloudDetail(t: Translate = translate): string {
  return t(
    'auto.components.new.workspace.RunTargetCombobox.orcaCloudDetail',
    // Non-breaking spaces keep each number with its unit when the row wraps.
    'Hosted sandbox · 4\u00a0vCPU\u00a0/\u00a08\u00a0GB'
  )
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
  if (isOrcaCloudRecipe(recipe)) {
    return getOrcaCloudDetail(t)
  }
  // Built-in providers run in-process; their lifecycle strings are labels, not commands to show.
  if (recipe.provider && recipe.description) {
    return recipe.description
  }
  return `${getRecipeCommandDisplay(recipe.create)} · ${getRecipeDestroyLabel(recipe, t)}`
}

export function getRunTargetHostRowKey(option: ReadyProjectHostSetupOption): string {
  return `host:${getProjectHostSetupSelectionKey(option)}`
}

/** The row that holds the committed selection, armed when the picker opens. */
export function getRunTargetCurrentRowKey(
  selectedRecipe: EphemeralVmRecipeOption | null,
  selectedHost: ReadyProjectHostSetupOption | null
): string | null {
  if (selectedRecipe) {
    return isOrcaCloudRecipe(selectedRecipe) ? RUN_TARGET_ORCA_CLOUD_KEY : RUN_TARGET_RECIPES_KEY
  }
  return selectedHost ? getRunTargetHostRowKey(selectedHost) : null
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query)
}

/** Show ready hosts first; bound and rank unready hosts, which may include every configured SSH host. */
function buildHostRows(
  hostOptions: readonly ProjectHostSetupOption[],
  query: string
): {
  readyRows: RunTargetRowModel[]
  needsSetupRows: RunTargetRowModel[]
  hiddenHostCount: number
} {
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
  return {
    readyRows: ready.map((option) => ({
      key: getRunTargetHostRowKey(option),
      kind: 'ready' as const,
      option
    })),
    needsSetupRows: needsSetup.shown.map(({ id, option }) => ({
      key: `needs:${id}`,
      kind: 'needs-setup' as const,
      option
    })),
    hiddenHostCount: needsSetup.hiddenCount
  }
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

export const ORCA_CLOUD_LABEL = 'Orca Cloud'

function matchOrcaCloud(
  recipes: readonly EphemeralVmRecipeOption[],
  offerWithoutRecipe: boolean,
  query: string,
  t?: Translate
): { recipe: EphemeralVmRecipeOption | null } | null {
  const recipe = recipes.find(isOrcaCloudRecipe) ?? null
  if (!recipe && !offerWithoutRecipe) {
    return null
  }
  if (query !== '' && !matches(ORCA_CLOUD_LABEL, query) && !matches(getOrcaCloudDetail(t), query)) {
    return null
  }
  return { recipe }
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

/** Keys of a submenu's rows in display order, for keyboard arming. */
export function getRunTargetSubmenuItemKeys(
  submenu: RunTargetSubmenu,
  {
    matchedRecipes,
    hasAddSshHost,
    hasAddRemoteServer
  }: {
    matchedRecipes: readonly EphemeralVmRecipeOption[]
    hasAddSshHost: boolean
    hasAddRemoteServer: boolean
  }
): string[] {
  if (submenu === 'recipes') {
    return matchedRecipes.map((recipe) => getRecipeSubmenuItemKey(recipe.id))
  }
  return [
    ...(hasAddSshHost ? [RUN_TARGET_ADD_SSH_HOST_ITEM] : []),
    ...(hasAddRemoteServer ? [RUN_TARGET_ADD_REMOTE_SERVER_ITEM] : [])
  ]
}

export function getRecipeSubmenuItemKey(recipeId: string): string {
  return `recipe:${recipeId}`
}

/** Filter host/recipe rows but always keep Add host reachable; other submenus require matching contents. */
export function buildRunTargetRows(
  {
    hostOptions,
    recipes,
    query,
    hasAddHost,
    orcaCloudOffered = false
  }: {
    hostOptions: readonly ProjectHostSetupOption[]
    recipes: readonly EphemeralVmRecipeOption[]
    query: string
    hasAddHost: boolean
    /** Show the Orca Cloud row (sign-in or upsell) even when the account has no Orca Cloud recipe. */
    orcaCloudOffered?: boolean
  },
  t?: Translate
): {
  rows: RunTargetRowModel[]
  matchedRecipes: EphemeralVmRecipeOption[]
  /** Hosts the row limit left out; typing narrows them in. */
  hiddenHostCount: number
} {
  const trimmed = query.trim().toLowerCase()
  // Orca Cloud is a first-class target, so it never also appears inside the recipe submenu.
  const orcaCloud = matchOrcaCloud(recipes, orcaCloudOffered, trimmed, t)
  const matchedRecipes = matchRecipes(
    recipes.filter((recipe) => !isOrcaCloudRecipe(recipe)),
    trimmed,
    t
  )
  const hostRows = buildHostRows(hostOptions, trimmed)
  const isLocalRow = (row: RunTargetRowModel): boolean =>
    row.kind === 'ready' && row.option.hostId === LOCAL_EXECUTION_HOST_ID
  const rows: RunTargetRowModel[] = [
    ...hostRows.readyRows.filter(isLocalRow),
    // Right under this machine, so it never scrolls away behind a long host list.
    ...(orcaCloud
      ? [
          {
            key: RUN_TARGET_ORCA_CLOUD_KEY,
            kind: 'orca-cloud',
            recipe: orcaCloud.recipe
          } satisfies RunTargetRowModel
        ]
      : []),
    ...hostRows.readyRows.filter((row) => !isLocalRow(row)),
    ...hostRows.needsSetupRows,
    ...buildSubmenuRows(matchedRecipes.length > 0, hasAddHost)
  ]
  return { rows, matchedRecipes, hiddenHostCount: hostRows.hiddenHostCount }
}
