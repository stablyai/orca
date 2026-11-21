import { useState } from 'react'
import { cn } from '@/lib/class-names'
import { BotFirstScreen } from '../bots/BotFirstScreen'
import { nativeChatFirstScreenSignIn } from '../../../../shared/bots/bot-first-screen'
import {
  NativeChatBotKickoffContext,
  useNativeChatBotKickoffView,
  type NativeChatBotKickoffView
} from './native-chat-bot-kickoff-view'
import { nativeChatStructuredStopControls } from './session/structured/writes/native-chat-structured-stop-controls'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatStructuredComposerTransport } from './composer/submit/native-chat-structured-composer-transport'

type BotHomeController = Parameters<typeof useNativeChatBotKickoffView>[1] &
  Parameters<typeof nativeChatStructuredStopControls>[0]

/** A bot Chat's kickoff view, and Stop controls that know when a new bot is first speaking. */
export function useNativeChatBotHome(
  session: { messages: readonly NativeChatMessage[] },
  controller: BotHomeController,
  transport: NativeChatStructuredComposerTransport,
  workspaceId: string | null,
  hostExecution: { stopping: boolean }
) {
  const kickoff = useNativeChatBotKickoffView(session.messages, controller, transport, workspaceId)
  return {
    kickoff,
    /** Its setup card stands in for the transcript, and offers what setup needs. */
    setupFailed: kickoff.firstScreen?.phase === 'failed',
    /** The sign-in its failed setup waits on, which its setup card offers. */
    signInOwed: nativeChatFirstScreenSignIn(kickoff.firstScreen),
    stopControls: nativeChatStructuredStopControls(controller, hostExecution.stopping, kickoff)
  }
}

/** In a bot's Chat, until a new bot first speaks, its first screen stands in
 *  for the transcript, which stays mounted underneath and fades in once the greeting lands. */
export function NativeChatBotHomeScope({
  kickoff,
  isVisible,
  children
}: {
  kickoff: NativeChatBotKickoffView | undefined
  isVisible: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const firstScreen = kickoff?.firstScreen ?? null
  const [shownFirstScreen, setShownFirstScreen] = useState(false)
  if (firstScreen && !shownFirstScreen) {
    setShownFirstScreen(true)
  }
  if (!kickoff) {
    return <>{children}</>
  }
  return (
    <NativeChatBotKickoffContext.Provider value={kickoff}>
      {kickoff.bot ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col',
              firstScreen && 'invisible',
              !firstScreen &&
                shownFirstScreen &&
                'duration-300 animate-in fade-in motion-reduce:animate-none'
            )}
            aria-hidden={firstScreen ? true : undefined}
          >
            {children}
          </div>
          {firstScreen ? <BotFirstScreen firstScreen={firstScreen} isVisible={isVisible} /> : null}
        </div>
      ) : (
        children
      )}
    </NativeChatBotKickoffContext.Provider>
  )
}
