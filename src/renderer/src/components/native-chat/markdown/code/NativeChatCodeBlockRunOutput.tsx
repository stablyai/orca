import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { CodeBlockRunState } from '../../../../../../shared/code-block-terminal-run'

/** A Play run's output, under its code block. */
export function NativeChatCodeBlockRunOutput({
  state
}: {
  state: CodeBlockRunState
}): React.JSX.Element {
  const t = useTranslate()
  const status =
    state.status === 'running'
      ? t('components.native-chat.runRunning', 'Running…')
      : state.status === 'done'
        ? t('components.native-chat.runExited', 'Exit {{code}}', { code: state.exitCode })
        : state.reason === 'timeout'
          ? t('components.native-chat.runTimedOut', 'Stopped after 5 minutes')
          : state.reason === 'closed'
            ? t('components.native-chat.runClosed', 'The terminal closed before it finished')
            : (state.message ?? t('components.native-chat.runFailed', 'Could not run it'))
  const failed = state.status === 'failed' || (state.status === 'done' && state.exitCode !== 0)
  return (
    <div className="border-t border-chat-code-border px-3.5 py-2" aria-live="polite">
      {state.output ? (
        <pre className="scrollbar-sleek m-0 max-h-80 overflow-auto font-mono text-chat-code text-chat-foreground-faint">
          {state.output}
        </pre>
      ) : null}
      <div
        className={cn(
          'mt-1 font-sans text-xs text-chat-foreground-faint',
          failed && 'text-destructive'
        )}
      >
        {status}
      </div>
    </div>
  )
}
