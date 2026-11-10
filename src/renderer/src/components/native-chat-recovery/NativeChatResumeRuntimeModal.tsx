import { useSyncExternalStore } from 'react'
import { localNativeChatRestartStore } from './offers/native-chat-resume-on-restart-store'
import type { NativeChatRestartStore } from './offers/native-chat-restart-runtime-store'
import { NativeChatResumeOccurrenceModal } from './NativeChatResumeOnRestartModal'
import { useLocalStructuredChatsInUse } from '../../runtime/native-chat/local-sessions/local-structured-chats'
import { useNativeChatRestartRuntimes } from './offers/native-chat-restart-runtimes'

export function NativeChatResumeOnRestartModal(): React.JSX.Element {
  const enabled = useLocalStructuredChatsInUse()
  const runtimes = useNativeChatRestartRuntimes()
  return (
    <>
      <NativeChatResumeRuntimeModal store={localNativeChatRestartStore} offerEnabled={enabled} />
      {runtimes.map(({ environment, store }) => (
        <NativeChatResumeRuntimeModal
          key={environment.id}
          store={store}
          machineName={environment.name}
          offerEnabled
        />
      ))}
    </>
  )
}

export function NativeChatResumeRuntimeModal({
  store,
  machineName,
  offerEnabled
}: {
  store: NativeChatRestartStore
  machineName?: string
  offerEnabled: boolean
}): React.JSX.Element | null {
  const occurrence = useSyncExternalStore(
    store.subscribe,
    store.getNativeChatRestartOccurrence,
    store.getNativeChatRestartOccurrence
  )
  return (
    <NativeChatResumeOccurrenceModal
      key={occurrence.identity}
      store={store}
      machineName={machineName}
      offerEnabled={offerEnabled}
    />
  )
}
