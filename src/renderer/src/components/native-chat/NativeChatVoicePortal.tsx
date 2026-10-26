import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { useVoiceSidebarSessions } from '@/store/voice-sidebar-state'
import { NativeChatVoiceSession } from './NativeChatVoiceSession'

export function NativeChatVoicePortal({
  tabId,
  ...props
}: ComponentProps<typeof NativeChatVoiceSession> & { tabId: string }): React.JSX.Element | null {
  const portal = useVoiceSidebarSessions((state) => state.portal)
  if (!props.isVisible || portal?.tabId !== tabId) {
    return null
  }
  return createPortal(<NativeChatVoiceSession {...props} />, portal.container)
}
