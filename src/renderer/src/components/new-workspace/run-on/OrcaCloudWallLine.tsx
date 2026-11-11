import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaCloudWallNotice } from '@/lib/orca-cloud/run-on-preflight'

/**
 * JA-21b (flagged): under Run on when Orca Cloud is the selected target and a billing wall applies.
 * The reason, then the one fix (or who can fix it) on its own line, flush with the reason: one
 * layout in the narrow column, never a dangling separator (design-squad). Create waits until fixed.
 */
export function OrcaCloudWallLine({ wall }: { wall: OrcaCloudWallNotice }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div role="status" className="flex flex-col items-start text-[11px]" data-orca-cloud-wall>
      {/* Wraps rather than truncating: the glossary reason is never cut. */}
      <p className="text-muted-foreground">{wall.reason}</p>
      {wall.action ? (
        // statusAction pads its label by px-1; the wrapper's -mx-1 puts the text flush-left.
        <div className="-mx-1">
          <Button type="button" variant="link" size="statusAction" onClick={wall.action.run}>
            {wall.action.label}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskOwnerOrAdmin',
            'Ask an owner or admin'
          )}
        </p>
      )}
    </div>
  )
}
