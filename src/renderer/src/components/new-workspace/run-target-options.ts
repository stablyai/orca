import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { translate } from '@/i18n/i18n'
import { boundHostList } from '@/components/host-picker/bounded-host-list'
import type { MachineGroupOption } from '@/lib/machines/machine-group-options'
import {
  buildMachineRows,
  type MachineGroupView,
  type MachineRowModel
} from './run-target-machine-rows'

export type EphemeralVmRecipeOption = NonNullable<OrcaHooks['environmentRecipes']>[number]

export const RUN_TARGET_ADD_HOST_KEY = 'add-host'
export const RUN_TARGET_RECIPES_KEY = 'per-workspace-env'
const RUN_TARGET_HOST_GROUP_KEY = 'host-group'

type HostGroupHeaderRow = { key: typeof RUN_TARGET_HOST_GROUP_KEY; kind: 'host-group' }

/** A row in the run-target list. Hosts commit; recipes and Add host open a submenu. */
export type RunTargetRowModel =
  | { key: string; kind: 'ready'; option: ReadyProjectHostSetupOption }
  | { key: string; kind: 'needs-setup'; option: NeedsSetupProjectHostOption }
  | { key: typeof RUN_TARGET_RECIPES_KEY; kind: 'recipes' }
  | { key: typeof RUN_TARGET_ADD_HOST_KEY; kind: 'add-host' }
  | HostGroupHeaderRow
  | MachineRowModel

export type RunTargetHeaderRow = Extract<
  RunTargetRowModel,
  { kind: 'host-group' | 'machine-group' }
>
export type SelectableRunTargetRow = Exclude<RunTargetRowModel, RunTargetHeaderRow>

/** Group headers label rows but can't be armed or committed. */
export function isSelectableRunTargetRow(row: RunTargetRowModel): row is SelectableRunTargetRow {
  return row.kind !== 'machine-group' && row.kind !== 'host-group'
}

/** Rows under one header, or a run of rows no header labels. */
export type RunTargetRowSection = {
  key: string
  header: RunTargetHeaderRow | null
  rows: SelectableRunTargetRow[]
}

function sectionOf(row: SelectableRunTargetRow): 'machines' | 'hosts' | null {
  switch (row.kind) {
    case 'needs-setup':
      return 'hosts'
    case 'ready':
    case 'recipes':
    case 'add-host':
      return null
    case 'machine':
    case 'machine-more':
    case 'machine-archived':
    case 'machine-create':
    case 'machine-sign-in':
    case 'machine-retry':
    case 'machine-details':
      return 'machines'
  }
}

/** Splits the flat row list into the sections the list renders, one per header. */
export function sectionRunTargetRows(rows: readonly RunTargetRowModel[]): RunTargetRowSection[] {
  const sections: RunTargetRowSection[] = []
  let current: RunTargetRowSection | null = null
  for (const row of rows) {
    if (!isSelectableRunTargetRow(row)) {
      current = { key: row.key, header: row, rows: [] }
      sections.push(current)
      continue
    }
    const header = current?.header ?? null
    const belongs =
      header !== null && sectionOf(row) === (header.kind === 'host-group' ? 'hosts' : 'machines')
    if (!current || (header !== null && !belongs)) {
      current = { key: `rows:${row.key}`, header: null, rows: [] }
      sections.push(current)
    }
    current.rows.push(row)
  }
  return sections
}

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

export function readyHostRowKey(option: ReadyProjectHostSetupOption): string {
  return `host:${getProjectHostSetupSelectionKey(option)}`
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query)
}

/** Hosts that can run now, and hosts that still need a connection or a project location. */
function buildHostRows(
  hostOptions: readonly ProjectHostSetupOption[],
  query: string
): { ready: RunTargetRowModel[]; needsSetup: RunTargetRowModel[]; hiddenHostCount: number } {
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
    ready: ready.map((option) => ({
      key: readyHostRowKey(option),
      kind: 'ready' as const,
      option
    })),
    needsSetup: needsSetup.shown.map(({ id, option }) => ({
      key: `needs:${id}`,
      kind: 'needs-setup' as const,
      option
    })),
    hiddenHostCount: needsSetup.hiddenCount
  }
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
  machineGroups = [],
  machineViews = {},
  query,
  hasAddHost
}: {
  hostOptions: readonly ProjectHostSetupOption[]
  recipes: readonly EphemeralVmRecipeOption[]
  machineGroups?: readonly MachineGroupOption[]
  machineViews?: Readonly<Record<string, MachineGroupView>>
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
  const hosts = buildHostRows(hostOptions, trimmed)
  const machineRows = buildMachineRows({
    groups: machineGroups,
    query: trimmed,
    views: machineViews
  })
  // Why: beside provider groups, unconnected hosts need their own label or they read as machines.
  const hostHeader: RunTargetRowModel[] =
    machineRows.length > 0 && hosts.needsSetup.length > 0
      ? [{ key: RUN_TARGET_HOST_GROUP_KEY, kind: 'host-group' }]
      : []
  // Why: machines can run now, so they sit above hosts that still need a connection.
  const rows: RunTargetRowModel[] = [
    ...hosts.ready,
    ...machineRows,
    ...hostHeader,
    ...hosts.needsSetup,
    ...buildSubmenuRows(matchedRecipes.length > 0, hasAddHost)
  ]
  return { rows, matchedRecipes, hiddenHostCount: hosts.hiddenHostCount }
}
