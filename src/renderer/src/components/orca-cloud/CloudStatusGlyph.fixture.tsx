import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { cloudGlyphStateLabel } from './cloud-state-copy'
import { CloudStatusGlyph, type CloudGlyphState } from './CloudStatusGlyph'

const STATES: CloudGlyphState[] = [
  'running',
  'waking',
  'starting',
  'restarting',
  'goingToSleep',
  'sleeping',
  'archived',
  'unresponsive',
  'failed',
  'wakeFailed',
  'unknown'
]

// The sidebar's three row backgrounds: plain, hover and selected.
const BACKGROUNDS = [
  { name: 'sidebar', className: 'bg-worktree-sidebar' },
  { name: 'hover', className: 'bg-worktree-sidebar-accent/55' },
  { name: 'selected', className: 'bg-worktree-sidebar-accent' }
]

function Sheet({ greyscale = false }: { greyscale?: boolean }): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-2 bg-worktree-sidebar p-3 text-[11px] text-worktree-sidebar-foreground"
      style={greyscale ? { filter: 'grayscale(1)' } : undefined}
    >
      {BACKGROUNDS.map((background) => (
        <div key={background.name} className={`rounded-md p-2 ${background.className}`}>
          <div className="mb-1.5 text-muted-foreground">{background.name}</div>
          <div className="grid grid-cols-11 gap-x-2 gap-y-1.5">
            {STATES.map((state) => (
              <div key={state} className="flex flex-col items-center gap-1">
                <div className="flex items-end gap-1.5">
                  <CloudStatusGlyph state={state} size={12} />
                  <CloudStatusGlyph state={state} size={14} />
                  <CloudStatusGlyph state={state} size={16} />
                </div>
                <span className="w-16 truncate text-center text-[10px] text-muted-foreground">
                  {cloudGlyphStateLabel(state)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Every state at 12, 14 and 16 px on the sidebar's plain, hover and selected backgrounds. */
export const allStates = defineFixture({
  width: 960,
  render: () => <Sheet />
})

/** The same sheet in greyscale: fill shape alone must tell every state apart. */
export const greyscale = defineFixture({
  width: 960,
  render: () => <Sheet greyscale />
})
