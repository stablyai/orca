import { useCallback } from 'react'
import { useNativeChatViewState } from '../../pane/ownership/native-chat-view-memory'
import { toggleNativeChatExpandedKey } from './native-chat-expanded-keys'

const NO_EXPANDED_TURNS: ReadonlySet<string> = new Set()

/** A transcript's expanded turns, kept with its chat tab so a released view returns with them open. */
export function useNativeChatExpandedTurns(
  transcriptKey: string
): [ReadonlySet<string>, (turnKey: string) => void] {
  const [expanded, setExpanded] = useNativeChatViewState(
    `expanded-turns:${transcriptKey}`,
    NO_EXPANDED_TURNS
  )
  const toggle = useCallback(
    (turnKey: string) => setExpanded((current) => toggleNativeChatExpandedKey(current, turnKey)),
    [setExpanded]
  )
  return [expanded, toggle]
}
