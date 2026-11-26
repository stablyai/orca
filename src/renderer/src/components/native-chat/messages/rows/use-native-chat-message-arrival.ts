import { useContext, useEffect, useState } from 'react'
import { NativeChatReplyRevealsContext } from '../../markdown/native-chat-reply-reveals'

export function useNativeChatMessageArrival(key: string | undefined, enabled: boolean): boolean {
  const reveals = useContext(NativeChatReplyRevealsContext)
  const [arriving] = useState(
    () =>
      enabled && key !== undefined && reveals?.begun.has(key) === true && !reveals.arrived?.has(key)
  )
  useEffect(() => {
    if (arriving && key !== undefined && reveals) {
      reveals.arrived?.add(key)
    }
  }, [arriving, key, reveals])
  return arriving && enabled
}
