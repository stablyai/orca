import React, { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { CodeBlockRunInput } from '../../../../../../shared/code-block-terminal-run'

/** Answers a running block's prompt (a `yes`, a password-free choice): Enter sends the line, Stop sends Ctrl+C. */
export function NativeChatCodeBlockRunInput({
  input
}: {
  input: CodeBlockRunInput
}): React.JSX.Element {
  const t = useTranslate()
  const [line, setLine] = useState('')
  const [sending, setSending] = useState(false)
  const send = (): void => {
    if (sending) {
      return
    }
    setSending(true)
    void input
      .send(line)
      .then(() => setLine(''))
      .catch(() => {})
      .finally(() => setSending(false))
  }
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <input
        type="text"
        value={line}
        disabled={sending}
        onChange={(event) => setLine(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          }
        }}
        aria-label={t('components.native-chat.runReplyLabel', 'Reply to the command')}
        placeholder={t('components.native-chat.runReplyPlaceholder', 'Type a reply, Enter to send')}
        className="min-w-0 flex-1 rounded-md border border-chat-code-border bg-transparent px-2 py-1 font-mono text-chat-code text-chat-code-foreground placeholder:text-chat-foreground-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button
        type="button"
        onClick={() => void input.interrupt().catch(() => {})}
        className="shrink-0 rounded-md px-2 py-1 font-sans text-xs text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('components.native-chat.runStop', 'Stop')}
      </button>
    </div>
  )
}
