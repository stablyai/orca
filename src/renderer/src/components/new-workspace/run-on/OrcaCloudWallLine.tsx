import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaCloudWallNotice } from '@/lib/orca-cloud/run-on-preflight'

/**
 * JA-21b (flagged): under Run on when Orca Cloud is the selected target and a billing wall applies.
 * One line: why it can't start, and the one fix (or who can fix it). Create waits until it's fixed.
 */
export function OrcaCloudWallLine({ wall }: { wall: OrcaCloudWallNotice }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p
      role="status"
      className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-[11px] text-muted-foreground"
      data-orca-cloud-wall
    >
      {/* Wraps rather than truncating: the glossary reason is never cut (design-squad). */}
      <span>{wall.reason}</span>
      <span aria-hidden>·</span>
      {wall.action ? (
        <Button type="button" variant="link" size="xs" onClick={wall.action.run}>
          <span className="text-[11px]">{wall.action.label}</span>
        </Button>
      ) : (
        <span className="shrink-0">
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskOwnerOrAdmin',
            'Ask an owner or admin'
          )}
        </span>
      )}
    </p>
  )
}
