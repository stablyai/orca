import { useSyncExternalStore } from 'react'
import {
  localNativeChatRestartStore,
  type NativeChatRestartStore
} from './native-chat-resume-on-restart-store'
import { NativeChatResumeOccurrenceModal } from './NativeChatResumeOnRestartModal'
import { useNativeChatRestartOfferEnabled } from './native-chat-restart-offer-gate'
import { useNativeChatRestartRuntimes } from './native-chat-restart-runtimes'

export function NativeChatResumeOnRestartModal(): React.JSX.Element {
  const enabled = useNativeChatRestartOfferEnabled()
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
