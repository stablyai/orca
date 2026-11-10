// The hint under Run on for this computer or a "⋯" target: where it runs (spec E1). When Orca
// Cloud can't be reached, the line says so (X2) so the disabled segment never looks like a bug.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import type { OrcaCloudAvailability } from '../../../../../shared/orca-yaml-hook-types'
import { getRecipeDetail, type EphemeralVmRecipeOption } from '../run-target-options'

export function RunOnHintLine({
  hostOptions,
  selectedHostId,
  recipes,
  selectedRecipeId,
  orcaCloudAvailability
}: {
  hostOptions: readonly ProjectHostSetupOption[]
  selectedHostId: string | null
  recipes: readonly EphemeralVmRecipeOption[]
  selectedRecipeId: string | null
  orcaCloudAvailability: OrcaCloudAvailability
}): React.JSX.Element | null {
  const t = useTranslate()
  const recipe = recipes.find((candidate) => candidate.id === selectedRecipeId) ?? null
  const host = hostOptions.find((option) => option.id === selectedHostId) ?? null
  const where = recipe ? getRecipeDetail(recipe, t) : host ? `${host.label} · ${host.detail}` : null
  return (
    <div className="space-y-0.5">
      {where ? <p className="truncate text-[11px] text-muted-foreground">{where}</p> : null}
      {orcaCloudAvailability === 'unreachable' ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          {t(
            'components.newWorkspace.runOn.cloudUnreachableReason',
            "Orca Cloud: can't reach it right now. Check your connection."
          )}
        </p>
      ) : null}
    </div>
  )
}
