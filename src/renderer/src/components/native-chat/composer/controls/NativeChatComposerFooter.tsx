import type { ComponentProps } from 'react'
import { NativeChatComposerWorkspace } from './NativeChatComposerWorkspace'
import { NativeChatTokenUsageFooter } from '../../usage/NativeChatTokenUsageFooter'
import type { NativeChatContextUsageSummary } from '../../../../../../shared/native-chat/native-chat-context-usage-summary'

export function NativeChatComposerFooter({
  contextUsageSummary,
  ...workspace
}: ComponentProps<typeof NativeChatComposerWorkspace> & {
  contextUsageSummary: NativeChatContextUsageSummary | null
}): React.JSX.Element {
  return (
    <>
      {workspace.structuredTransport ? (
        <NativeChatTokenUsageFooter usage={contextUsageSummary} />
      ) : null}
      <NativeChatComposerWorkspace {...workspace} />
    </>
  )
}
