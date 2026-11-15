import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AgentStartingStatus } from './AgentStartingPortals'

function Pane({ elapsedMs }: { elapsedMs: number }): React.JSX.Element {
  const [startedAt] = useState(() => Date.now() - elapsedMs)
  return (
    <div className="relative h-[260px] border border-border bg-background">
      <span className="absolute top-1 left-1.5 inline-block h-4 w-2 bg-foreground/80" />
      <AgentStartingStatus agent="claude" startedAt={startedAt} />
    </div>
  )
}

/** A cloud Claude pane before Claude's first frame: says what is happening, never a bare cursor. */
export const starting = defineFixture({ width: 720, render: () => <Pane elapsedMs={4_000} /> })

export const startingStill = defineFixture({ width: 720, render: () => <Pane elapsedMs={13_000} /> })

export const startingSlow = defineFixture({ width: 720, render: () => <Pane elapsedMs={24_000} /> })
