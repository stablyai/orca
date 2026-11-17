import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaCloudDropReason } from '@/hooks/composer-state/workspace-target/useEphemeralVmRecipeOptions'

/**
 * A picked Orca Cloud stays picked across project changes. Only when the newly picked
 * project can't run on it does Run on fall back to this project's own target, and this line says why
 * instead of the switch happening silently. It goes away with the next pick.
 */
export function OrcaCloudDroppedLine({
  reason
}: {
  reason: OrcaCloudDropReason
}): React.JSX.Element {
  const t = useTranslate()
  const text =
    reason === 'elsewhere'
      ? t(
          'components.newWorkspace.runOn.cloudDroppedElsewhere',
          'Orca Cloud can’t run this project: it lives on another machine. Running it there instead.'
        )
      : reason === 'unreachable'
        ? t(
            'components.newWorkspace.runOn.cloudDroppedUnreachable',
            'Couldn’t reach Orca Cloud for this project, so Run on switched back. Pick Orca Cloud again to retry.'
          )
        : t(
            'components.newWorkspace.runOn.cloudDroppedUnavailable',
            'Orca Cloud isn’t available for this project, so Run on switched back.'
          )
  return (
    <p role="status" data-orca-cloud-dropped={reason} className="text-[11px] text-muted-foreground">
      {text}
    </p>
  )
}
