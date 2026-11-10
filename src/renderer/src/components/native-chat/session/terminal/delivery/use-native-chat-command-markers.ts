import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import {
  appendCommandMarkerCache,
  readCommandMarkerCache,
  type NativeChatCommandMarker,
  type NativeChatCommandMarkerScope
} from './native-chat-command-marker'

export function useNativeChatCommandMarkers(
  commandMarkerScope: NativeChatCommandMarkerScope,
  resetWorkingInterrupted: Dispatch<SetStateAction<boolean>>
) {
  // Slash commands are local session-scoped feedback, not user turns; cap and cache their markers.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  const [prevCommandMarkerScope, setPrevCommandMarkerScope] = useState(commandMarkerScope)
  if (prevCommandMarkerScope !== commandMarkerScope) {
    setPrevCommandMarkerScope(commandMarkerScope)
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    resetWorkingInterrupted(false)
  }
  const onSlashCommand = useCallback(
    (command: string, output?: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command, Date.now(), output))
    },
    [commandMarkerScope]
  )
  return { commandMarkers, onSlashCommand }
}
