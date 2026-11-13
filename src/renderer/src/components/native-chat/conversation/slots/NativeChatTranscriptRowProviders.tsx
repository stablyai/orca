import type { ReactNode } from 'react'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatDisclosureContext } from '../../messages/disclosure/native-chat-disclosure-store'
import { NativeChatPullRequestChangeContext } from '../../tools/pull-requests/NativeChatOpenedPullRequestCard'
import { NativeChatImageGalleryProvider } from '../../media/gallery/NativeChatImageGallery'

/** The chat-wide state transcript rows read: disclosures, the latest PR change and the image gallery. */
export function NativeChatTranscriptRowProviders({
  disclosures,
  pullRequestChangeKey,
  messages,
  children
}: {
  disclosures: React.ContextType<typeof NativeChatDisclosureContext>
  pullRequestChangeKey: React.ContextType<typeof NativeChatPullRequestChangeContext>
  messages: readonly NativeChatMessage[]
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatPullRequestChangeContext.Provider value={pullRequestChangeKey}>
        <NativeChatImageGalleryProvider messages={messages}>
          {children}
        </NativeChatImageGalleryProvider>
      </NativeChatPullRequestChangeContext.Provider>
    </NativeChatDisclosureContext.Provider>
  )
}
