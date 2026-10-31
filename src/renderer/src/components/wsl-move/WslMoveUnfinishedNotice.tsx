import React, { useEffect } from 'react'
import { Info } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { refreshWslMoveUnfinished, useWslMoveDialogStore } from './wsl-move-dialog-store'

/** Committed moves whose automations the host has not turned back on yet; never left unsaid. */
export function WslMoveUnfinishedNotice(): React.JSX.Element | null {
  const unfinished = useWslMoveDialogStore((s) => s.unfinished)
  useEffect(() => {
    void refreshWslMoveUnfinished()
  }, [])
  const lines = unfinished.filter((move) => move.automationsPending.length > 0)
  if (lines.length === 0) {
    return null
  }
  return (
    <ul className="space-y-1" data-testid="wsl-move-unfinished">
      {lines.map((move) => (
        <li key={move.migrationId} className="flex gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {move.automationsPending.length === 1
              ? translate(
                  'wslMove.unfinished.one',
                  'One automation moved to the {{distro}} host is still off. Orca keeps asking the host to turn it back on.',
                  { distro: move.distro }
                )
              : translate(
                  'wslMove.unfinished.many',
                  '{{n}} automations moved to the {{distro}} host are still off. Orca keeps asking the host to turn them back on.',
                  { n: move.automationsPending.length, distro: move.distro }
                )}
          </span>
        </li>
      ))}
    </ul>
  )
}
