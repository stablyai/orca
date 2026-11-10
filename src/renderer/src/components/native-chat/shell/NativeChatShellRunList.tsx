import { useMemo, useState } from 'react'
import { Check, ChevronDown, Plus, RotateCw, Square, SquareTerminal, X } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { structuredAgentSessionDraftScopeKey } from '../drafts/native-chat-draft-scope'
import { useNativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import { NativeChatCopyButton } from '../messages/actions/NativeChatCopyButton'
import {
  dismissNativeChatShellRun,
  nativeChatShellRunOutput,
  runNativeChatShellCommand,
  setNativeChatShellRunAdded,
  stopNativeChatShellRun,
  useNativeChatShellRuns,
  type NativeChatShellRun
} from './native-chat-shell-runs'
import {
  NATIVE_CHAT_SHELL_COLLAPSED_LINES,
  NativeChatShellRunOutput,
  nativeChatShellOutputRows
} from './NativeChatShellRunOutput'

function RunStatus({ run }: { run: NativeChatShellRun }): React.JSX.Element {
  const t = useTranslate()
  if (run.finishedAt === undefined) {
    return (
      <span className="flex items-center gap-1 text-chat-foreground-faint">
        <LoadingSpinner className="size-3" />
        {t('components.native-chat.composer.shellRunning', 'running')}
      </span>
    )
  }
  const seconds = `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
  const exit = run.exit
  const failed = run.error !== undefined || run.stopped || exit?.timedOut || exit?.exitCode !== 0
  const label = run.error
    ? t('components.native-chat.composer.shellFailed', 'failed')
    : run.stopped
      ? t('components.native-chat.composer.shellStopped', 'stopped')
      : exit?.timedOut
        ? t('components.native-chat.composer.shellTimedOut', 'timed out')
        : exit?.exitCode === 0
          ? t('components.native-chat.composer.shellFinished', 'finished')
          : t('components.native-chat.composer.shellExit', 'exit {{code}}', {
              code: exit?.exitCode ?? '?'
            })
  return (
    <span className="flex items-center gap-1.5 text-chat-foreground-faint">
      <span
        className={cn('size-1.5 rounded-full', failed ? 'bg-destructive' : 'bg-status-success')}
      />
      {label} · {seconds}
    </span>
  )
}

function ShellRunCard({ run }: { run: NativeChatShellRun }): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const running = run.finishedAt === undefined
  const rows = useMemo(() => nativeChatShellOutputRows(run.output), [run.output])
  const long = rows.length > NATIVE_CHAT_SHELL_COLLAPSED_LINES
  return (
    <li
      className={cn(
        'rounded-lg border bg-chat-code-surface transition-colors duration-200',
        run.added ? 'border-(--chat-shell-accent)' : 'border-chat-code-border'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <SquareTerminal className="size-3.5 text-chat-foreground-faint" />
        <span className="text-chat-foreground">
          {t('components.native-chat.composer.shellCommandLabel', 'Shell command')}
        </span>
        {run.directory ? (
          <span className="min-w-0 truncate font-mono text-chat-foreground-faint">
            {t('components.native-chat.composer.shellDirectory', 'in {{directory}}', {
              directory: run.directory
            })}
          </span>
        ) : null}
        <span className="ml-auto">
          <RunStatus run={run} />
        </span>
        {running ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('components.native-chat.composer.shellStop', 'Stop')}
            onClick={() => stopNativeChatShellRun(run.id)}
          >
            <Square />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('components.native-chat.composer.shellDismiss', 'Dismiss')}
          onClick={() => dismissNativeChatShellRun(run.id)}
        >
          <X />
        </Button>
      </div>
      <NativeChatShellRunOutput
        command={run.command}
        rows={rows}
        expanded={expanded || !long}
        running={running}
        error={run.error}
        outputTruncated={run.exit?.outputTruncated ?? false}
      />
      {long ? (
        <div className="flex justify-center pb-1">
          <Button type="button" variant="ghost" size="xs" onClick={() => setExpanded(!expanded)}>
            {expanded
              ? t('components.native-chat.composer.shellShowLess', 'Show less')
              : t('components.native-chat.composer.shellShowMore', 'Show more')}
            <ChevronDown className={cn(expanded && 'rotate-180')} />
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-1 border-t border-chat-code-border px-2 py-1">
        <NativeChatCopyButton
          text={nativeChatShellRunOutput(run)}
          label={t('components.native-chat.composer.shellCopyOutput', 'Copy output')}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('components.native-chat.composer.shellRerun', 'Run again')}
          disabled={running}
          onClick={() => runNativeChatShellCommand(run.scope, run.command)}
        >
          <RotateCw />
        </Button>
        {!running && !run.error ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            aria-pressed={run.added}
            onClick={() => setNativeChatShellRunAdded(run.id, !run.added)}
          >
            {run.added ? <Check /> : <Plus />}
            {run.added
              ? t('components.native-chat.composer.shellAdded', 'Added to chat')
              : t('components.native-chat.composer.shellAddToChat', 'Add to chat')}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

export function NativeChatShellRunCards({
  anchorIds
}: {
  anchorIds: readonly string[]
}): React.JSX.Element | null {
  const owner = useNativeChatVisualOwner()
  const scope = owner ? structuredAgentSessionDraftScopeKey(owner.sessionId) : null
  const runs = useNativeChatShellRuns(
    (run) =>
      (scope === null || run.scope === scope) &&
      run.anchorId !== null &&
      anchorIds.includes(run.anchorId)
  )
  if (runs.length === 0) {
    return null
  }
  return (
    <ul className="flex flex-col gap-2">
      {runs.map((run) => (
        <ShellRunCard key={run.id} run={run} />
      ))}
    </ul>
  )
}

export function NativeChatShellRunList({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const runs = useNativeChatShellRuns((run) => run.scope === scope && run.anchorId === null)
  if (runs.length === 0) {
    return null
  }
  return (
    <ul className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 px-4 py-1">
      {runs.map((run) => (
        <ShellRunCard key={run.id} run={run} />
      ))}
    </ul>
  )
}
