import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '../../store'

const MAX_TOGGLED_TURNS = 128

type TurnToggles = {
  /** The default the toggles were made against; flipping the setting drops them. */
  expandByDefault: boolean
  turnKeys: ReadonlySet<string>
}

/** Which settled turns are open. Folded unless the reader opened them, or — with
 *  "Keep finished turns expanded" on — open unless the reader closed them. */
export function useNativeChatTurnExpansion(turnKeys: readonly (string | undefined)[]): {
  expandedTurnIds: ReadonlySet<string>
  toggleExpandedTurn: (turnKey: string) => void
} {
  const expandByDefault = useAppStore(
    (state) => state.settings?.nativeChatExpandFinishedTurns === true
  )
  const [toggles, setToggles] = useState<TurnToggles>({
    expandByDefault,
    turnKeys: new Set()
  })
  // Adjust-state-during-render: toggles made against the other default are meaningless.
  if (toggles.expandByDefault !== expandByDefault) {
    setToggles({ expandByDefault, turnKeys: new Set() })
  }
  const toggled = toggles.expandByDefault === expandByDefault ? toggles.turnKeys : null

  const toggleExpandedTurn = useCallback(
    (turnKey: string) => {
      setToggles((current) => {
        const next = new Set(
          current.expandByDefault === expandByDefault ? current.turnKeys : undefined
        )
        if (next.has(turnKey)) {
          next.delete(turnKey)
        } else {
          if (next.size >= MAX_TOGGLED_TURNS) {
            const oldest = next.values().next().value
            if (oldest) {
              next.delete(oldest)
            }
          }
          next.add(turnKey)
        }
        return { expandByDefault, turnKeys: next }
      })
    },
    [expandByDefault]
  )

  const expandedTurnIds = useMemo((): ReadonlySet<string> => {
    if (!expandByDefault) {
      return toggled ?? new Set()
    }
    const expanded = new Set<string>()
    for (const turnKey of turnKeys) {
      if (turnKey !== undefined && !toggled?.has(turnKey)) {
        expanded.add(turnKey)
      }
    }
    return expanded
  }, [expandByDefault, toggled, turnKeys])

  return { expandedTurnIds, toggleExpandedTurn }
}
