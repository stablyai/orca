import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { nativeChatUserMessageFolds } from './native-chat-user-message-fold'

export function NativeChatUserMessageFold({
  messageId,
  markdown,
  onRefolded,
  children
}: {
  messageId: string
  markdown: string
  /** After the reader folded the prompt again, once its new height is laid out. */
  onRefolded?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const disclosure = useNativeChatDisclosure(`user-message:${messageId}`, false)
  const longText = useMemo(() => nativeChatUserMessageFolds(markdown), [markdown])
  // The text rule can pick a prompt that already fits the clip; that one gets no fade or toggle.
  // Tied to the text it was measured for: a superseding copy of the message is measured again.
  const [measured, setMeasured] = useState({ markdown, fits: false })
  const fits = measured.markdown === markdown && measured.fits
  const folds = longText && !fits
  const folded = folds && !disclosure.open
  const clipRef = useRef<HTMLDivElement | null>(null)
  const clipId = useId()
  const toggledRef = useRef(false)
  useLayoutEffect(() => {
    const clip = clipRef.current
    if (folded && clip) {
      const fitsNow = clip.scrollHeight <= clip.clientHeight
      setMeasured((current) =>
        current.markdown === markdown && current.fits === fitsNow
          ? current
          : { markdown, fits: fitsNow }
      )
    }
    if (toggledRef.current) {
      toggledRef.current = false
      if (folded) {
        onRefolded?.()
      }
    }
  }, [folded, markdown, onRefolded])

  return (
    <>
      <div
        ref={clipRef}
        id={clipId}
        data-native-chat-user-message-folded={folded ? '' : undefined}
        className={cn(folded && 'max-h-44 overflow-hidden mask-b-from-[calc(100%-1.75rem)]')}
        // Tabbing to a link under the fold scrolls the preview to it; the top returns once focus leaves.
        onBlur={(event) => {
          if (document.hasFocus() && !event.currentTarget.contains(event.relatedTarget)) {
            event.currentTarget.scrollTop = 0
          }
        }}
      >
        {children}
      </div>
      {folds ? (
        <div className="-mr-1.5 -mb-1 mt-1 flex select-none justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={disclosure.open}
            aria-controls={clipId}
            onClick={() => {
              toggledRef.current = true
              disclosure.setOpen(!disclosure.open)
            }}
          >
            {disclosure.open
              ? translate('components.native-chat.userMessage.showLess', 'Show less')
              : translate('components.native-chat.userMessage.showFull', 'Show full message')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
