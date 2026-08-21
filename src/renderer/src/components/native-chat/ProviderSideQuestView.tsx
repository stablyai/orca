import type { SideQuestSessionReference } from '../../../../shared/side-quest-types'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatMessageList } from './NativeChatMessageList'
import { ProviderSideQuestComposer } from './ProviderSideQuestComposer'
import { useProviderSideQuestSession } from './use-provider-side-quest-session'

export function ProviderSideQuestView({
  terminalTabId,
  sessionReference
}: {
  terminalTabId: string
  sessionReference: SideQuestSessionReference
}): React.JSX.Element {
  const provider = useProviderSideQuestSession(sessionReference.providerThreadId)
  const hasMessages = provider.session.messages.length > 0
  const error = sessionReference.error ?? provider.session.error ?? null
  const providerReady =
    sessionReference.status === 'ready' && sessionReference.providerThreadId !== null

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {hasMessages || provider.isWorking ? (
          <NativeChatMessageList
            session={provider.session}
            isWorking={provider.isWorking}
            expandSignal={false}
            fontScale={1}
            allowFileUriLinks
          />
        ) : error ? (
          <NativeChatEmptyState kind="error" message={error} agent="codex" />
        ) : providerReady ? (
          <NativeChatEmptyState kind="empty" agent="codex" />
        ) : (
          <NativeChatEmptyState kind="loading" agent="codex" />
        )}
      </div>
      <ProviderSideQuestComposer
        terminalTabId={terminalTabId}
        providerReady={providerReady}
        isWorking={provider.isWorking}
        error={error}
        onSend={provider.send}
        onStop={provider.interrupt}
      />
    </div>
  )
}
