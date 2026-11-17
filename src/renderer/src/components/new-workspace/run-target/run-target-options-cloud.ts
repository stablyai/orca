import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { EphemeralVmRecipeOption, RunTargetRowModel } from './run-target-options'

export const RUN_TARGET_ORCA_CLOUD_KEY = 'orca-cloud'
export const ORCA_CLOUD_LABEL = 'Orca Cloud'

/** The Orca Cloud row of the run-target list; it commits like a host. */
export type OrcaCloudRunTargetRow = {
  key: typeof RUN_TARGET_ORCA_CLOUD_KEY
  kind: 'orca-cloud'
  /** Null for the sign-in/upsell row shown before the account can use Orca Cloud. */
  recipe: EphemeralVmRecipeOption | null
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
  return `${t('auto.components.new.workspace.RunTargetCombobox.orcaCloudHosted', 'Sandbox')} · ${t(
    'auto.components.new.workspace.RunTargetCombobox.orcaCloudSpecs2',
    '{{value0}} vCPU · {{value1}} GB',
    {
      value0: String(ORCA_CLOUD_SANDBOX_SPEC.vcpus),
      value1: String(ORCA_CLOUD_SANDBOX_SPEC.memoryGb)
    }
  )}`
}

function matches(haystack: string, query: string): boolean {
  return haystack.toLowerCase().includes(query)
}

/** The Orca Cloud row for a trimmed, lowercased query, or null when it is not offered or filtered out. */
export function matchOrcaCloudRow(
  recipes: readonly EphemeralVmRecipeOption[],
  offerWithoutRecipe: boolean,
  query: string,
  t?: Translate
): OrcaCloudRunTargetRow | null {
  const recipe = recipes.find(isOrcaCloudRecipe) ?? null
  if (!recipe && !offerWithoutRecipe) {
    return null
  }
  if (query !== '' && !matches(ORCA_CLOUD_LABEL, query) && !matches(getOrcaCloudDetail(t), query)) {
    return null
  }
  return { key: RUN_TARGET_ORCA_CLOUD_KEY, kind: 'orca-cloud', recipe }
}

/** Orca Cloud is a first-class target, so it never also appears inside the recipe submenu. */
export function withoutOrcaCloudRecipes(
  recipes: readonly EphemeralVmRecipeOption[]
): EphemeralVmRecipeOption[] {
  return recipes.filter((recipe) => !isOrcaCloudRecipe(recipe))
}

/**
 * This machine first, then Orca Cloud right under it (so it never scrolls away behind a long host
 * list), then the other hosts in their order.
 */
export function withOrcaCloudRow(
  hostRows: readonly RunTargetRowModel[],
  orcaCloud: OrcaCloudRunTargetRow | null
): RunTargetRowModel[] {
  const isLocalRow = (row: RunTargetRowModel): boolean =>
    row.kind === 'ready' && row.option.hostId === LOCAL_EXECUTION_HOST_ID
  return [
    ...hostRows.filter(isLocalRow),
    ...(orcaCloud ? [orcaCloud] : []),
    ...hostRows.filter((row) => !isLocalRow(row))
  ]
}
