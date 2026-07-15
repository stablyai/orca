import { useMemo, useState } from 'react'
import { ChevronRight, Files } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { NativeChatToolStep } from './native-chat-message-grouping'
import type {
  NativeChatReportedFileChange,
  NativeChatReportedFileChangeCollection,
  NativeChatReportedFileChangeStatus
} from './native-chat-reported-file-changes'
import {
  MAX_REPORTED_FILE_CHANGE_TEXT_CHARS,
  MAX_REPORTED_FILE_CHANGE_TEXT_LINES,
  readNativeChatReportedFileInputPath,
  readNativeChatReportedFilePatchText
} from './native-chat-reported-file-changes'
import { extractNativeChatReportedFilePatch } from './native-chat-reported-file-change-parser-patch'
import {
  projectDiffFromText,
  projectDiffFromToolCall,
  type NativeChatDiffProjection
} from './native-chat-diff'
import { NativeChatDiffView } from './NativeChatDiffView'

const MAX_FILE_DIFF_LINES = 400
const MAX_FILE_DIFF_TEXT_CHARS = 32_000
const FILE_DIFF_LIMITS = {
  maxChars: MAX_FILE_DIFF_TEXT_CHARS,
  maxLines: MAX_FILE_DIFF_LINES
} as const
const PATCH_SCAN_LIMITS = {
  maxChars: MAX_REPORTED_FILE_CHANGE_TEXT_CHARS,
  maxLines: MAX_REPORTED_FILE_CHANGE_TEXT_LINES
} as const

function statusText(status: NativeChatReportedFileChangeStatus): string {
  const labels: Record<NativeChatReportedFileChangeStatus, string> = {
    added: translate('components.native-chat.tool.fileAdded', 'Added'),
    modified: translate('components.native-chat.tool.fileModified', 'Modified'),
    deleted: translate('components.native-chat.tool.fileDeleted', 'Deleted'),
    renamed: translate('components.native-chat.tool.fileRenamed', 'Renamed')
  }
  return labels[status]
}

function statusClassName(status: NativeChatReportedFileChangeStatus): string {
  const classes: Record<NativeChatReportedFileChangeStatus, string> = {
    added: 'text-[var(--git-decoration-added)]',
    modified: 'text-[var(--git-decoration-modified)]',
    deleted: 'text-[var(--git-decoration-deleted)]',
    renamed: 'text-[var(--git-decoration-renamed)]'
  }
  return classes[status]
}

function sameRuntimePath(left: string | null, right: string): boolean {
  return Boolean(
    left && normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  )
}

function projectionFromPatch(value: string | null, path: string): NativeChatDiffProjection | null {
  if (!value) {
    return null
  }
  const selected = extractNativeChatReportedFilePatch(value, path, PATCH_SCAN_LIMITS)
  if (!selected) {
    return null
  }
  const projection = projectDiffFromText(selected.text, FILE_DIFF_LIMITS)
  if (!projection) {
    return selected.truncated ? { lines: [], source: 'unified', truncated: true } : null
  }
  return { ...projection, truncated: projection.truncated || selected.truncated }
}

function projectionForStep(
  change: NativeChatReportedFileChange,
  step: NativeChatToolStep,
  exclusivelyReferencesStep: boolean
): NativeChatDiffProjection | null {
  const inputPatch = step.call
    ? projectionFromPatch(readNativeChatReportedFilePatchText(step.call.input), change.path)
    : null
  if (inputPatch) {
    return inputPatch
  }
  const outputPatch = projectionFromPatch(step.result?.output ?? null, change.path)
  if (outputPatch) {
    return outputPatch
  }
  if (
    step.call &&
    sameRuntimePath(readNativeChatReportedFileInputPath(step.call.input), change.path)
  ) {
    const direct = projectDiffFromToolCall(step.call.name, step.call.input, FILE_DIFF_LIMITS)
    if (direct) {
      return direct
    }
  }
  return exclusivelyReferencesStep
    ? projectDiffFromText(step.result?.output ?? '', FILE_DIFF_LIMITS)
    : null
}

function combineProjections(
  projections: readonly NativeChatDiffProjection[]
): NativeChatDiffProjection | null {
  if (projections.length === 0) {
    return null
  }
  const lines = projections.flatMap((projection, index) => [
    ...(index > 0 ? [{ kind: 'meta' as const, text: '…' }] : []),
    ...projection.lines
  ])
  return {
    lines: lines.slice(0, MAX_FILE_DIFF_LINES),
    source: projections.every((projection) => projection.source === 'unified')
      ? 'unified'
      : 'synthetic',
    truncated:
      projections.some((projection) => projection.truncated) || lines.length > MAX_FILE_DIFF_LINES
  }
}

export function buildNativeChatReportedFileDiffs(
  changes: readonly NativeChatReportedFileChange[],
  steps: readonly NativeChatToolStep[]
): (NativeChatDiffProjection | null)[] {
  const referenceCounts = new Map<number, number>()
  for (const change of changes) {
    for (const stepIndex of change.stepIndexes) {
      referenceCounts.set(stepIndex, (referenceCounts.get(stepIndex) ?? 0) + 1)
    }
  }
  return changes.map((change) =>
    combineProjections(
      change.stepIndexes.flatMap((stepIndex) => {
        const step = steps[stepIndex]
        if (!step) {
          return []
        }
        const projection = projectionForStep(change, step, referenceCounts.get(stepIndex) === 1)
        return projection ? [projection] : []
      })
    )
  )
}

export function nativeChatReportedFileLinkHref(path: string): string {
  // Why: the general link resolver strips query/hash/line suffixes before decoding.
  // Segment encoding preserves those characters when they are part of a filename.
  return path.split('/').map(encodeURIComponent).join('/')
}

function FilePath({
  change,
  onLinkClick
}: {
  change: NativeChatReportedFileChange
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element {
  const tooltip = change.previousPath ? `${change.previousPath} → ${change.path}` : change.path
  if (!onLinkClick) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="min-w-0 truncate font-mono text-[11px] text-foreground/80">
            {change.path}
          </code>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(event) => onLinkClick(event, nativeChatReportedFileLinkHref(change.path))}
          className="min-w-0 truncate rounded-sm font-mono text-[11px] text-foreground/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {change.path}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function FileRow({
  change,
  diff,
  onLinkClick
}: {
  change: NativeChatReportedFileChange
  diff: NativeChatDiffProjection | null
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const additions =
    diff?.source === 'unified' ? diff.lines.filter((line) => line.kind === 'add').length : 0
  const deletions =
    diff?.source === 'unified' ? diff.lines.filter((line) => line.kind === 'del').length : 0
  const hasDiff = Boolean(diff && (diff.lines.length > 0 || diff.truncated))

  return (
    <div>
      <div className="flex min-w-0 items-center gap-1.5 py-1">
        {hasDiff ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={translate(
              open
                ? 'components.native-chat.tool.hideFileDiff'
                : 'components.native-chat.tool.showFileDiff',
              open ? `Hide diff for ${change.path}` : `Show diff for ${change.path}`,
              { path: change.path }
            )}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform motion-reduce:transition-none',
                open && 'rotate-90'
              )}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <span className={cn('shrink-0 text-[11px] font-medium', statusClassName(change.status))}>
          {statusText(change.status)}
        </span>
        <FilePath change={change} onLinkClick={onLinkClick} />
        {change.binary ? (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {translate('components.native-chat.tool.binary', 'Binary')}
          </span>
        ) : additions || deletions ? (
          <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-[11px]">
            <span className="text-[var(--git-decoration-added)]">+{additions}</span>
            <span className="text-[var(--git-decoration-deleted)]">-{deletions}</span>
          </span>
        ) : null}
      </div>
      {open && diff ? (
        <div className="pb-2 pl-6">
          <NativeChatDiffView lines={diff.lines} truncated={diff.truncated} />
        </div>
      ) : null}
    </div>
  )
}

/** A separate disclosure keeps reported paths reviewable without reopening all
 * command details. Paths still flow through the existing worktree-aware handler. */
export function NativeChatReportedFiles({
  collection,
  steps,
  onLinkClick
}: {
  collection: NativeChatReportedFileChangeCollection
  steps: NativeChatToolStep[]
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const diffs = useMemo(
    () => (open ? buildNativeChatReportedFileDiffs(collection.changes, steps) : []),
    [collection.changes, open, steps]
  )
  if (collection.changes.length === 0) {
    return null
  }
  const label = translate(
    collection.changes.length === 1
      ? 'components.native-chat.tool.reportedFileOne'
      : 'components.native-chat.tool.reportedFileMany',
    collection.changes.length === 1
      ? '1 reported file'
      : `${collection.changes.length} reported files`,
    { count: collection.changes.length }
  )

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 rounded-sm py-1 text-left text-muted-foreground hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Files className="size-3.5 shrink-0" />
        <span className="font-mono text-[11px]">{label}</span>
        {collection.truncated ? (
          <span className="text-[11px]">
            · {translate('components.native-chat.tool.partial', 'Partial')}
          </span>
        ) : null}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
      </button>
      {open ? (
        <div className="ml-1.5 border-l border-border pl-3">
          {collection.changes.map((change, index) => (
            <FileRow
              key={normalizeRuntimePathForComparison(change.path)}
              change={change}
              diff={diffs[index] ?? null}
              onLinkClick={onLinkClick}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
