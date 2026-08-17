import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendCommandMarkerCache,
  clearBoundaryForSlashCommand,
  readCommandMarkerCache,
  type NativeChatCommandMarker,
  type NativeChatCommandMarkerScope
} from './native-chat-command-markers'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

export function useNativeChatCommandMarkers(args: {
  paneKey: string
  agent: string
  sessionId: string | null
  sourceKey?: string
  messages: readonly NativeChatMessage[]
  transcriptOrder: NativeChatTranscriptOrder
  onWorkingInterruptReset: () => void
}): {
  commandMarkers: NativeChatCommandMarker[]
  onSlashCommand: (command: string) => void
} {
  const {
    paneKey,
    agent,
    sessionId,
    sourceKey,
    messages,
    transcriptOrder,
    onWorkingInterruptReset
  } = args
  const commandMarkerScope = useMemo(
    (): NativeChatCommandMarkerScope => ({ paneKey, agent, sessionId, sourceKey }),
    [paneKey, agent, sessionId, sourceKey]
  )
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  const activeScopeRef = useRef(commandMarkerScope)
  const visibleCommandMarkers =
    activeScopeRef.current === commandMarkerScope
      ? commandMarkers
      : readCommandMarkerCache(commandMarkerScope)
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    activeScopeRef.current = commandMarkerScope
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    onWorkingInterruptReset()
  }, [commandMarkerScope, onWorkingInterruptReset])
  const onSlashCommand = useCallback(
    (command: string) => {
      // Why: an ordered id boundary also hides older rows prepended after clear.
      setCommandMarkers(
        appendCommandMarkerCache(
          commandMarkerScope,
          command,
          Date.now(),
          clearBoundaryForSlashCommand(command, messages, transcriptOrder)
        )
      )
    },
    [commandMarkerScope, messages, transcriptOrder]
  )
  return { commandMarkers: visibleCommandMarkers, onSlashCommand }
}
