// Small pieces of the "Move to this computer" view.
import React, { useEffect } from 'react'
import type { CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'

/** Neutral bullets for what will move (not checkmarks: nothing has happened yet). */
export function BulletList({
  items
}: {
  items: { key: string; node: React.ReactNode }[]
}): React.JSX.Element {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm marker:text-muted-foreground">
      {items.map((item) => (
        <li key={item.key}>{item.node}</li>
      ))}
    </ul>
  )
}

/** Moves focus to the stage's main control whenever the stage changes. */
export function useFocusOnStage(
  stage: Exclude<CloudMoveState, { stage: 'closed' }>['stage'],
  ref: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    ref.current?.focus()
  }, [stage, ref])
}
