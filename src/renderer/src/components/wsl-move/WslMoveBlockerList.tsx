import React from 'react'
import { CircleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type {
  WslMoveBlocker,
  WslMoveRowRef
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import { wslMoveBlockerHint, wslMoveBlockerTitle } from './wsl-move-copy'

/** One blocker kind, with the projects it names that the user can leave out of the move. */
export type WslMoveBlockerView = {
  blocker: WslMoveBlocker
  /** The projects holding it, when known; "Skip" is offered only where main allows it. */
  projects: (WslMoveRowRef & { name: string })[]
}

export function WslMoveBlockerList({
  blockers,
  onSkip
}: {
  blockers: WslMoveBlockerView[]
  onSkip?: (refs: WslMoveRowRef[]) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2" data-testid="wsl-move-blockers">
      <div className="text-xs font-medium text-muted-foreground">
        {translate('wslMove.blockers.title', 'Before these projects can move')}
      </div>
      <ul className="space-y-2">
        {blockers.map(({ blocker, projects }) => {
          const canSkip = onSkip && blocker.actions.includes('skip-project') && projects.length > 0
          return (
            <li
              key={blocker.kind}
              className="flex gap-2.5 rounded-md border border-border px-3 py-2"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="font-medium">
                  {wslMoveBlockerTitle(blocker.kind, blocker.ids.length)}
                </div>
                {projects.length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {translate('wslMove.blockers.inProjects', 'In {{names}}', {
                      names: projects.map((project) => project.name).join(', ')
                    })}
                  </div>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  {wslMoveBlockerHint(blocker.kind)}
                </div>
                {canSkip ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => onSkip(projects)}
                  >
                    {projects.length === 1
                      ? translate('wslMove.blockers.skipOne', 'Leave {{name}} out of this move', {
                          name: projects[0].name
                        })
                      : translate(
                          'wslMove.blockers.skipMany',
                          'Leave these {{n}} projects out of this move',
                          { n: projects.length }
                        )}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
