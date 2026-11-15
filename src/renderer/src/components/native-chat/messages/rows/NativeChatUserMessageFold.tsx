import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'
import { nativeChatUserMessageFolds } from '../../../../../../shared/native-chat/transcript/folding/native-chat-user-message-fold'
import {
  NATIVE_CHAT_UNKERNED_CSS,
  nativeChatTextHasUnkernedRun
} from '../../composer/editor/native-chat-unkerned-runs'

export function NativeChatUserMessageFold({
  messageId,
  markdown,
  onRefolded,
  className,
  foldLines,
  children
}: {
  messageId: string
  markdown: string
  className?: string
  /** Folds any text taller than this many lines, instead of only long prompts at the usual height. */
  foldLines?: number
  /** After the reader folded the prompt again, once its new height is laid out. */
  onRefolded?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const disclosure = useNativeChatDisclosure(`user-message:${messageId}`, false)
  const lineFold = foldLines !== undefined
  const longText = useMemo(() => nativeChatUserMessageFolds(markdown), [markdown])
  // A fold clips but still lays out the whole text, so it needs the composer's long-run rule.
  const unkerned = useMemo(() => nativeChatTextHasUnkernedRun(markdown), [markdown])
  // Measure each text revision; long-text heuristics can select a prompt that already fits the clip.
  const [measured, setMeasured] = useState({ markdown, fits: false })
  const fits = measured.markdown === markdown && measured.fits
  // A line-count fold always clamps; whether the clamp hides anything depends on the width.
  const [clampHides, setClampHides] = useState(false)
  const folds = lineFold ? clampHides || disclosure.open : longText && !fits
  const folded = lineFold ? !disclosure.open : folds && !disclosure.open
  const clipRef = useRef<HTMLDivElement | null>(null)
  const clipId = useId()
  const toggledRef = useRef(false)
  useLayoutEffect(() => {
    const clip = clipRef.current
    if (!lineFold || !folded || !clip) {
      return undefined
    }
    const measure = (): void => setClampHides(clip.scrollHeight > clip.clientHeight)
    measure()
    // The pane narrowing or widening changes how many lines the text wraps to.
    const observer = new ResizeObserver(measure)
    observer.observe(clip)
    return () => observer.disconnect()
  }, [folded, lineFold, markdown])
  useLayoutEffect(() => {
    const clip = clipRef.current
    if (folded && clip && !lineFold) {
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
  }, [folded, lineFold, markdown, onRefolded])

  return (
    <>
      <div
        ref={clipRef}
        id={clipId}
        data-native-chat-user-message-folded={folded ? '' : undefined}
        className={cn(
          className,
          folded &&
            (foldLines === undefined
              ? 'max-h-44 overflow-hidden mask-b-from-[calc(100%-1.75rem)]'
              : // Clamps whole lines, ending the last with an ellipsis, across the text's paragraphs.
                'overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical]')
        )}
        style={{
          ...(unkerned ? NATIVE_CHAT_UNKERNED_CSS : undefined),
          ...(folded && foldLines !== undefined ? { WebkitLineClamp: foldLines } : undefined)
        }}
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
              ? t('components.native-chat.userMessage.showLess', 'Show less')
              : t('components.native-chat.userMessage.showFull', 'Show full message')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
