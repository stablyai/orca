import type { NativeChatTranscriptSlot } from '../../../conversation/slots/native-chat-transcript-slots'
import type { NativeChatTranscriptWindow } from '../../../viewport/virtualization/use-native-chat-transcript-window'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import type { StructuredAgentSendingSource } from '../../../../../../../shared/agent-session/view/structured-agent-sending-source'

const noSubscription = () => () => {}
const notPending = () => false

type Gate = ReturnType<StructuredAgentSendingSource['gateFor']>
const SendingContext = createContext<
  { source: StructuredAgentSendingSource; ids: ReadonlySet<string>; gate: Gate } | undefined
>(undefined)

export function StructuredAgentSendingScope({
  source,
  displayedIds,
  children
}: {
  source?: StructuredAgentSendingSource
  displayedIds: ReadonlySet<string>
  children?: ReactNode
}): ReactNode {
  const [ids, setIds] = useState(displayedIds)
  if (
    ids !== displayedIds &&
    (ids.size !== displayedIds.size || Array.from(displayedIds).some((id) => !ids.has(id)))
  ) {
    setIds(displayedIds)
  }
  const sending = useMemo(() => source && { source, ids, gate: source.gateFor(ids) }, [source, ids])
  return <SendingContext value={sending}>{children}</SendingContext>
}

export function useStructuredAgentItemSending(id: string | undefined): boolean {
  const context = useContext(SendingContext)
  const source = id !== undefined && context?.ids.has(id) ? context.source : undefined
  const subscribe = useCallback(
    (listener: () => void) =>
      id === undefined ? noSubscription() : (source?.subscribeId(id, listener) ?? noSubscription()),
    [id, source]
  )
  return useSyncExternalStore(subscribe, () => id !== undefined && source?.getId(id) === true)
}

export function useStructuredAgentDisplayedSendPending(): boolean {
  const gate = useContext(SendingContext)?.gate
  return useSyncExternalStore(gate?.subscribe ?? noSubscription, gate?.getSnapshot ?? notPending)
}

export function StructuredAgentWorkingGate({
  children,
  whileSending = false
}: {
  children: ReactNode
  whileSending?: boolean
}): ReactNode {
  return useStructuredAgentDisplayedSendPending() === whileSending ? children : null
}

export function useDisplayedSendingSlots(
  sendingSource: StructuredAgentSendingSource,
  slots: readonly NativeChatTranscriptSlot[],
  { virtualItems }: NativeChatTranscriptWindow,
  waitingSlots: readonly NativeChatTranscriptSlot[]
): ReadonlySet<string> {
  return useMemo(() => {
    const ids = new Set<string>()
    const include = (slot: (typeof slots)[number] | undefined) => {
      if (
        slot?.kind === 'message' &&
        slot.drawsMessage &&
        !slot.receipt &&
        sendingSource.candidates.has(slot.message.id)
      ) {
        ids.add(slot.message.id)
      }
    }
    for (const { index } of virtualItems) {
      include(slots[index])
    }
    waitingSlots.forEach(include)
    return ids
  }, [sendingSource, slots, virtualItems, waitingSlots])
}
