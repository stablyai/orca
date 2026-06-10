import React from 'react'
import { Sparkles } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { TypingIndicator } from './TypingIndicator'

type Props = {
  running: boolean
  stream: { text: string; thinking: string } | null
  activity: string | null
}

// Why: keep only the tail of in-flight thinking visible — full reasoning can be
// thousands of chars and would dwarf the conversation while streaming.
const THINKING_TAIL_CHARS = 240

function ActivityLine({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Sparkles size={11} className="shrink-0 animate-pulse" />
      <span className="italic">{label}</span>
    </div>
  )
}

export function ChatStreamTail({ running, stream, activity }: Props): React.JSX.Element | null {
  if (!running) {
    return null
  }

  const text = stream?.text ?? ''
  const thinking = stream?.thinking ?? ''

  // Nothing streamed yet → iMessage-style typing dots (with the activity label).
  if (!text && !thinking) {
    return (
      <div className="flex flex-col gap-1">
        <TypingIndicator />
        {activity && <ActivityLine label={activity} />}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {activity && activity !== 'Thinking…' && <ActivityLine label={activity} />}
      {thinking && !text && (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Sparkles size={11} className="shrink-0 mt-0.5 animate-pulse" />
          <p className="italic whitespace-pre-wrap break-words max-w-[90%]">
            {thinking.length > THINKING_TAIL_CHARS
              ? `…${thinking.slice(-THINKING_TAIL_CHARS)}`
              : thinking}
          </p>
        </div>
      )}
      {text && (
        <div className="flex justify-start">
          <CommentMarkdown
            content={text}
            variant="document"
            className="max-w-[90%] text-sm text-foreground"
          />
        </div>
      )}
    </div>
  )
}
