import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { NativeChatContextUsageRing } from './NativeChatContextUsageRing'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { useNativeChatContextUsageSummary } from './use-native-chat-context-usage-summary'

/** The prompt replaces the composer, so its context readout needs a canvas placement. */
export function NativeChatPromptContextUsage({
  transport
}: {
  transport: Pick<NativeChatStructuredComposerTransport, 'contextUsage'>
}): React.JSX.Element | null {
  const usage = useNativeChatContextUsageSummary(transport)
  useUiLanguageRevision()
  if (!usage) {
    return null
  }
  return (
    <div className="shrink-0 bg-chat-pane">
      <div className="mx-auto flex w-full max-w-(--chat-content-max-width) justify-end px-3 pt-2 sm:px-4">
        <NativeChatContextUsageRing usage={usage} surface="canvas" />
      </div>
    </div>
  )
}
