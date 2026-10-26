import { useCallback } from 'react'
import { AudioLines, Plus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { createVoiceSidebarSession, useVoiceSidebarWorkspace } from '@/store/voice-sidebar-session'
import { useVoiceSidebarSessions } from '@/store/voice-sidebar-state'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from '@/components/native-chat/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '@/components/native-chat/use-native-chat-store-appearance-style'
import { cn } from '@/lib/utils'

export default function VoiceSidebarPanel(): React.JSX.Element {
  const workspace = useVoiceSidebarWorkspace()
  return <VoiceWorkspacePanel key={workspace.key ?? 'none'} workspace={workspace} />
}

function VoiceWorkspacePanel({
  workspace
}: {
  workspace: ReturnType<typeof useVoiceSidebarWorkspace>
}): React.JSX.Element {
  const { worktreeId, executionHostId, key: workspaceKey, entry, tab } = workspace
  const target = structuredAgentSessionTargetForHost(executionHostId)
  const appearance = useNativeChatStoreAppearanceStyle()
  const tabId = tab?.id
  const attach = useCallback(
    (container: HTMLDivElement | null) => {
      useVoiceSidebarSessions.setState({
        portal: container && tabId ? { tabId, container } : null
      })
    },
    [tabId]
  )
  const create = () => {
    if (!workspaceKey || !worktreeId || !executionHostId) {
      return
    }
    void createVoiceSidebarSession(workspaceKey, worktreeId, executionHostId)
  }
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={translate('stsVoice.open', 'Voice conversation')}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <AudioLines className="size-4 shrink-0" aria-hidden />
        <h2 className="flex-1 text-sm font-medium">
          {translate('stsVoice.open', 'Voice conversation')}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={translate('stsVoice.settings', 'Voice settings')}
          onClick={() => {
            useAppStore.getState().openSettingsTarget({ pane: 'voice', repoId: null })
            useAppStore.getState().openSettingsPage()
          }}
        >
          <Settings2 className="size-4" />
        </Button>
      </header>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {tab?.label || translate('stsHistory.noChat', 'No Codex chat selected')}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={!worktreeId || !target || entry?.status === 'opening'}
          onClick={create}
        >
          <Plus className="size-4" aria-hidden />
          {translate('stsHistory.newChat', 'New chat')}
        </Button>
      </div>
      {entry?.status === 'failed' ? (
        <p role="alert" className="px-3 py-2 text-sm">
          {translate('stsHistory.createFailed', 'Could not open a new chat. Try again.')}
        </p>
      ) : null}
      {tab && target ? (
        <div
          ref={attach}
          className={cn(NATIVE_CHAT_APPEARANCE_ROOT_CLASS, 'flex min-h-0 min-w-0 flex-1 flex-col')}
          style={appearance}
          data-native-chat-scheme={appearance.colorScheme}
        />
      ) : (
        <div className="space-y-3 p-3 text-sm">
          <p role="status">
            {!worktreeId || !target
              ? translate(
                  'stsLive.chooseWorkspace',
                  'Select a workspace with a connected Codex host.'
                )
              : entry?.status === 'opening'
                ? translate('stsLive.opening', 'Preparing your voice conversation…')
                : translate(
                    'stsHistory.selectChat',
                    'Select an open Codex chat to continue by voice, or choose New chat.'
                  )}
          </p>
        </div>
      )}
    </section>
  )
}
