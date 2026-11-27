import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { NativeChatComposerInput } from '../editor/native-chat-composer-input'

function isMentionTriggerAt(value: string, at: number): boolean {
  return value[at] === '@' && (at === 0 || /\s/.test(value[at - 1]))
}

export function useNativeChatPickerDismissal(
  context: string,
  inputRef: RefObject<NativeChatComposerInput | null>
) {
  const [dismissed, setDismissed] = useState<{ context: string; triggerKey: string } | null>(null)
  const release = useRef<(() => void) | null>(null)
  const clear = useCallback(() => {
    release.current?.()
    release.current = null
    setDismissed(null)
  }, [])
  useEffect(() => {
    clear()
    return () => {
      release.current?.()
      release.current = null
    }
  }, [context, clear])

  const dismiss = useCallback(
    (triggerKey: string) => {
      clear()
      setDismissed({ context, triggerKey })
      const input = inputRef.current
      if (input && triggerKey.startsWith('@:')) {
        release.current =
          input.trackTextPosition?.(Number(triggerKey.slice(2)), (at) => {
            if (at === null || !isMentionTriggerAt(input.value, at)) {
              clear()
            } else {
              setDismissed({ context, triggerKey: `@:${at}` })
            }
          }) ?? null
      }
    },
    [clear, context, inputRef]
  )
  const handleMentionChange = useCallback(
    (value: string, triggerKey: string): boolean => {
      if (!triggerKey.startsWith('@:')) {
        return false
      }
      // The editor owns occurrence identity, independently of query text and caret moves.
      if (!release.current && !isMentionTriggerAt(value, Number(triggerKey.slice(2)))) {
        clear()
      }
      return true
    },
    [clear]
  )
  return { dismissed, dismiss, clear, handleMentionChange }
}
