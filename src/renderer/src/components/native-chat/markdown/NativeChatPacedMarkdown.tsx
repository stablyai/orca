import { memo, useRef, useState, type ComponentProps } from 'react'
import { nativeChatPhraseEnd } from '../../../../../shared/native-chat/transcript/row-content/native-chat-phrase-chunks'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { useNativeChatPacedText } from './use-native-chat-paced-text'
import { useKeptMathSelection } from './use-kept-math-selection'

/** A save the reveal takes in changes its state, not the text drawn yet; that renders no reply. */
const PacedMarkdownBody = memo(NativeChatMarkdown)

/** Isolate paced text updates so animation frames do not rerender the rest of the row. */
export function NativeChatPacedMarkdown({
  rowKey,
  content,
  streaming,
  savedRevision,
  phraseChunks = false,
  ...props
}: Omit<
  ComponentProps<typeof NativeChatMarkdown>,
  'growing' | 'fadeFrom' | 'fadeHold' | 'fadeAnimates'
> & {
  phraseChunks?: boolean
  rowKey: string
  streaming: boolean
  /** The row's saved journal revision, where it has one. */
  savedRevision?: number
}): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const paced = useNativeChatPacedText(rowKey, content, streaming, root, savedRevision)
  const reducedMotion = usePrefersReducedMotion()
  const [phrase, setPhrase] = useState({ text: '', fadeFrom: 0 })
  const previousPhraseEnd = content.startsWith(phrase.text) ? phrase.text.length : 0
  const end = phraseChunks
    ? nativeChatPhraseEnd(
        content,
        previousPhraseEnd,
        paced.text.length,
        !streaming || reducedMotion || paced.text === content
      )
    : paced.text.length
  const shown = phraseChunks ? content.slice(0, end) : paced.text
  if (phraseChunks && phrase.text !== shown) {
    setPhrase({ text: shown, fadeFrom: Math.min(paced.fadeFrom ?? end, previousPhraseEnd) })
  }
  useKeptMathSelection(root, streaming || paced.revealing)
  return (
    <PacedMarkdownBody
      {...props}
      ref={root}
      rowKey={rowKey}
      content={shown}
      streaming={streaming || paced.revealing}
      fadeFrom={
        phraseChunks && paced.fadeFrom !== undefined
          ? Math.min(paced.fadeFrom, phrase.fadeFrom)
          : paced.fadeFrom
      }
      fadeHold={
        phraseChunks && paced.fadeHold
          ? { from: Math.min(paced.fadeHold.from, end), to: Math.min(paced.fadeHold.to, end) }
          : paced.fadeHold
      }
      fadeAnimates={paced.fadeAnimates}
    />
  )
}
