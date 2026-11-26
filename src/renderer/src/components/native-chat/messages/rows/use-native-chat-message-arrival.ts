import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { useCallback, useContext, useEffect, useState } from 'react'
import { NativeChatReplyRevealsContext } from '../../markdown/native-chat-reply-reveals'

export function useNativeChatMessageArrival(
  key: string | undefined,
  enabled: boolean
): { arriving: boolean; finish: () => void } {
  const reveals = useContext(NativeChatReplyRevealsContext)
  const reducedMotion = usePrefersReducedMotion()
  const [arriving, setArriving] = useState(
    () =>
      !reducedMotion &&
      enabled &&
      key !== undefined &&
      reveals?.begun.has(key) === true &&
      !reveals.arrived?.has(key)
  )
  useEffect(() => {
    if (enabled && key !== undefined && reveals?.begun.has(key)) {
      reveals.arrived?.add(key)
    }
  }, [enabled, key, reveals])
  const finish = useCallback(() => setArriving(false), [])
  return { arriving: arriving && enabled && !reducedMotion, finish }
}
