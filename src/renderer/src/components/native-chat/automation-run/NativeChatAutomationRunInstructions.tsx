import { useId, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { nativeChatFindHits } from '../viewport/find/native-chat-find-query'
import { RUN_LINK_BUTTON } from './automation-run-link-button'

/** The automation's saved prompt: four lines, then Show all. Shown whole while Find matches it. */
export function NativeChatAutomationRunInstructions({
  messageId,
  instructions,
  findQuery,
  showAll,
  showLess
}: {
  messageId: string
  instructions: string
  findQuery: string
  showAll: string
  showLess: string
}): React.JSX.Element {
  const disclosure = useNativeChatDisclosure(`automation-run-instructions:${messageId}`, false)
  const whole = disclosure.open || nativeChatFindHits(instructions, findQuery)
  const clipRef = useRef<HTMLDivElement | null>(null)
  const clipId = useId()
  // Measured, since four lines of Markdown depend on the pane's width.
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const clip = clipRef.current
    if (!clip || whole) {
      return
    }
    const measure = (): void => setOverflows(clip.scrollHeight > clip.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(clip)
    return () => observer.disconnect()
  }, [whole, instructions])
  return (
    <>
      <div ref={clipRef} id={clipId} className={cn(!whole && 'line-clamp-4')}>
        <NativeChatMarkdown
          rowKey={`${messageId}:instructions`}
          content={instructions}
          variant="document"
          className="text-sm"
          renderCodeBlock={NativeChatCodeBlock}
        />
      </div>
      {overflows || disclosure.open ? (
        <button
          type="button"
          className={cn(RUN_LINK_BUTTON, 'mt-1')}
          aria-expanded={whole}
          aria-controls={clipId}
          onClick={() => disclosure.setOpen(!disclosure.open)}
        >
          {disclosure.open ? showLess : showAll}
        </button>
      ) : null}
    </>
  )
}
