import { useEffect, useRef, useState } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_VISUAL_RESERVED_HEIGHT, NativeChatVisualFrame } from './NativeChatVisualFrame'
import { observeTranscriptVisibility } from './NativeChatTranscriptChrome'
import type { NativeChatVisualOwner } from './native-chat-visual-owner'
import { useNativeChatVisualDocument } from './use-native-chat-visual-document'

export function NativeChatVisualUnavailable(): React.JSX.Element {
  return (
    <p className="my-2 text-xs text-muted-foreground">
      {translate('components.native-chat.visualUnavailable', 'Visualization unavailable')}
    </p>
  )
}

/**
 * A visual inside an assistant reply. Its frame mounts once the reply scrolls near it and stays
 * mounted, so what the reader did in it survives scrolling away and back.
 */
export function NativeChatInlineVisual({
  owner,
  file,
  title
}: {
  owner: NativeChatVisualOwner
  file: string
  title: string | null
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  const [retired, setRetired] = useState(false)
  const openChatVisualTab = useAppStore((state) => state.openChatVisualTab)
  const state = useNativeChatVisualDocument(
    { target: owner.target, sessionId: owner.sessionId, file },
    near
  )

  useEffect(() => {
    const element = boxRef.current
    if (!element || near) {
      return
    }
    return observeTranscriptVisibility(element, (visible) => {
      if (visible) {
        setNear(true)
      }
    })
  }, [near])

  if (retired || state.status === 'unavailable') {
    return <NativeChatVisualUnavailable />
  }
  const label = title ?? file
  const openLabel = translate('components.native-chat.visualOpenInNewTab', 'Open in new tab')

  return (
    <div ref={boxRef} className="group/visual relative my-3">
      {state.status === 'ready' && near ? (
        <>
          <NativeChatVisualFrame
            document={state.document}
            title={label}
            layout="inline"
            themeScope={boxRef}
            onRetired={() => setRetired(true)}
          />
          <div className="absolute top-2 right-2 transition-opacity can-hover:opacity-0 group-hover/visual:opacity-100 focus-within:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={openLabel}
                  onClick={() =>
                    openChatVisualTab(owner.worktreeId, {
                      target: owner.target,
                      sessionId: owner.sessionId,
                      file,
                      title
                    })
                  }
                >
                  <SquareArrowOutUpRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {openLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        </>
      ) : (
        <div
          role="status"
          aria-label={translate('components.native-chat.visualLoading', 'Loading visualization')}
          className="w-full rounded-md bg-muted/30"
          style={{ height: NATIVE_CHAT_VISUAL_RESERVED_HEIGHT }}
        />
      )}
    </div>
  )
}
