import { Folder, FolderGit2, GitBranch, Server, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'

function WorkTargetKindIcon({
  target,
  className = 'size-3 shrink-0'
}: {
  target: AgentJournalWorkTarget
  className?: string
}): React.JSX.Element {
  if (target.kind === 'workspace') {
    return target.workspaceKind === 'folder' ? (
      <Folder className={className} aria-hidden />
    ) : (
      <GitBranch className={className} aria-hidden />
    )
  }
  return target.repoKind === 'folder' ? (
    <Folder className={className} aria-hidden />
  ) : (
    <FolderGit2 className={className} aria-hidden />
  )
}

function workTargetSummary(target: AgentJournalWorkTarget): string {
  if (
    target.kind === 'workspace' &&
    target.projectName &&
    target.projectName !== target.displayName
  ) {
    return `${target.projectName} / ${target.displayName}`
  }
  return target.displayName
}

/** Interactive draft chip shown in the composer while a target is armed for the next message. */
export function NativeChatComposerWorkTargetChip({
  target,
  disabled = false,
  onOpenPicker,
  onClear
}: {
  target: AgentJournalWorkTarget
  disabled?: boolean
  onOpenPicker: () => void
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const summary = workTargetSummary(target)
  const showHost = target.hostId !== LOCAL_EXECUTION_HOST_ID && Boolean(target.hostLabel)
  const scopeHint =
    target.kind === 'project'
      ? t('components.native-chat.workTarget.nextMessageProject', 'Next message · project')
      : t('components.native-chat.workTarget.nextMessageWorkspace', 'Next message · workspace')

  return (
    <div
      data-work-target-chip=""
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-secondary/50 py-0.5 pl-2 pr-0.5 text-xs text-foreground"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onOpenPicker}
        className={cn(
          'inline-flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
          disabled && 'cursor-not-allowed opacity-60'
        )}
        title={scopeHint}
      >
        <WorkTargetKindIcon target={target} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{summary}</span>
        {showHost ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-background/70 px-1 py-px text-2xs text-muted-foreground">
            <Server className="size-2.5 shrink-0" aria-hidden />
            <span className="max-w-24 truncate">{target.hostLabel}</span>
          </span>
        ) : null}
      </button>
      <Button
        type="button"
        variant="muted-field-icon"
        size="icon-xs"
        disabled={disabled}
        aria-label={t('components.native-chat.workTarget.clear', 'Clear selected target')}
        onClick={onClear}
        className="size-5 shrink-0"
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}

/** Compact read-only target tag shown on queued cards and sent user messages. */
export function NativeChatWorkTargetTag({
  target,
  className
}: {
  target: AgentJournalWorkTarget
  className?: string
}): React.JSX.Element {
  const summary = workTargetSummary(target)
  const showHost = target.hostId !== LOCAL_EXECUTION_HOST_ID && Boolean(target.hostLabel)

  return (
    <div
      data-work-target-tag=""
      className={cn(
        'inline-flex max-w-full items-center gap-1 text-2xs text-chat-foreground-faint',
        className
      )}
    >
      <WorkTargetKindIcon target={target} className="size-3 shrink-0" />
      <span className="truncate">{summary}</span>
      {showHost ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
          <span>·</span>
          <Server className="size-2.5 shrink-0" aria-hidden />
          <span className="max-w-24 truncate">{target.hostLabel}</span>
        </span>
      ) : null}
    </div>
  )
}
