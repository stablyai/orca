import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { CodeBlockRunState } from '../../../../../../shared/code-block-terminal-run'
import { NativeChatCodeBlockRunInput } from './NativeChatCodeBlockRunInput'

/** A Play run's output, under its code block. */
export function NativeChatCodeBlockRunOutput({
  state,
  hidden,
  onToggleHidden
}: {
  state: CodeBlockRunState
  /** Folded to its status line; the run and its output are kept. */
  hidden: boolean
  onToggleHidden: () => void
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
  const toggleLabel = hidden
    ? t('components.native-chat.runShowOutput', 'Show output')
    : t('components.native-chat.runHideOutput', 'Hide output')
  const Chevron = hidden ? ChevronRight : ChevronDown
  return (
    <div className="border-t border-chat-code-border px-3.5 py-2" aria-live="polite">
      {state.output && !hidden ? (
        <pre className="scrollbar-sleek m-0 max-h-80 overflow-auto font-mono text-chat-code text-chat-foreground-faint">
          {state.output}
        </pre>
      ) : null}
      <div
        className={cn(
          'flex items-center gap-1 font-sans text-xs text-chat-foreground-faint',
          !hidden && state.output && 'mt-1'
        )}
      >
        <button
          type="button"
          onClick={onToggleHidden}
          aria-expanded={!hidden}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron className="size-3.5" />
        </button>
        <span className={cn(failed && 'text-destructive')}>{status}</span>
      </div>
      {state.status === 'running' && state.input && !hidden ? (
        <NativeChatCodeBlockRunInput input={state.input} />
      ) : null}
    </div>
  )
}
