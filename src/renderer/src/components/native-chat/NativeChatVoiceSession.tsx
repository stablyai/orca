import type { ReactNode } from 'react'
import { NativeChatVoiceConversation } from './NativeChatVoiceConversation'
import { NativeChatVoiceLayout } from './NativeChatVoiceLayout'
import { NativeChatVoiceSettings } from './NativeChatVoiceSettings'
import { useAppStore } from '@/store'
import type { useNativeChatInstallSlot } from './NativeChatInstallSlot'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { nativeChatStructuredStopControls } from './native-chat-structured-stop-controls'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export function NativeChatVoiceSession({
  controller,
  transport,
  stopControls,
  composerShown,
  install,
  hostHeld,
  isVisible,
  history
}: {
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'status' | 'messages' | 'isWorking' | 'latestTurn'
  >
  transport: NativeChatStructuredComposerTransport
  stopControls: ReturnType<typeof nativeChatStructuredStopControls>
  composerShown: boolean
  install: ReturnType<typeof useNativeChatInstallSlot>
  hostHeld: boolean
  isVisible: boolean
  history: ReactNode
}): React.JSX.Element {
  const voice = useAppStore((store) => store.settings?.voice)
  return (
    <NativeChatVoiceLayout history={history}>
      <div className="scrollbar-sleek flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <NativeChatVoiceSettings
          voice={voice}
          transport={transport}
          working={controller.isWorking}
        />
        <NativeChatVoiceConversation
          active={isVisible}
          blocked={
            !composerShown ||
            Boolean(install.unavailableHint) ||
            stopControls.stopping ||
            hostHeld ||
            controller.status === 'idle' ||
            controller.status === 'loading' ||
            controller.status === 'error'
          }
          working={controller.isWorking}
          messages={controller.messages}
          transport={transport}
          completedTurn={
            controller.latestTurn?.turn.state === 'completed'
              ? controller.latestTurn.itemId
              : undefined
          }
          onStopAgent={() => stopControls.composer.onStop?.()}
        />
      </div>
    </NativeChatVoiceLayout>
  )
}
