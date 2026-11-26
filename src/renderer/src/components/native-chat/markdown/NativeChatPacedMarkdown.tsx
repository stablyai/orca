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
  const [phrase, setPhrase] = useState('')
  const end = phraseChunks
    ? nativeChatPhraseEnd(
        content,
        content.startsWith(phrase) ? phrase.length : 0,
        paced.text.length,
        !streaming || reducedMotion || paced.text === content
      )
    : paced.text.length
  const shown = phraseChunks ? content.slice(0, end) : paced.text
  if (phraseChunks && phrase !== shown) {
    setPhrase(shown)
  }
  useKeptMathSelection(root, streaming || paced.revealing)
  return (
    <PacedMarkdownBody
      {...props}
      ref={root}
      rowKey={rowKey}
      content={shown}
      streaming={streaming || paced.revealing}
      fadeFrom={paced.fadeFrom}
      fadeHold={paced.fadeHold}
      fadeAnimates={paced.fadeAnimates}
    />
  )
}
