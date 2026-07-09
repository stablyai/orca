import React from 'react'
import { History } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { worktreePathFromState } from '@/lib/worktree-path'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { getRuntimeGitLineBlame } from '@/runtime/runtime-git-client'
import type { GitLineBlameResult } from '../../../../shared/types'

// Why: hoisted to module scope so we don't reallocate the (non-trivial) Intl
// formatter on every render; locale-aware relative time avoids a key per unit.
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const RELATIVE_UNITS: readonly [
  limit: number,
  divisor: number,
  unit: Intl.RelativeTimeFormatUnit
][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
  [31_536_000, 2_592_000, 'month']
]

function formatRelative(ms: number): string {
  // Non-finite guard: a missing/garbage author-time must not reach Intl, which
  // throws a RangeError on NaN.
  if (!Number.isFinite(ms)) {
    return ''
  }
  const deltaSec = Math.round((ms - Date.now()) / 1000)
  const abs = Math.abs(deltaSec)
  for (const [limit, divisor, unit] of RELATIVE_UNITS) {
    if (abs < limit) {
      return relativeTimeFormatter.format(Math.round(deltaSec / divisor), unit)
    }
  }
  return relativeTimeFormatter.format(Math.round(deltaSec / 31_536_000), 'year')
}

export function LineBlameStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const activeFileId = useAppStore((s) => s.activeFileId)
  const openFiles = useAppStore((s) => s.openFiles)
  const cursorLine = useAppStore((s) =>
    s.activeFileId ? s.editorCursorLine[s.activeFileId] : undefined
  )
  const [blame, setBlame] = React.useState<GitLineBlameResult | null>(null)

  const activeFile = activeFileId ? openFiles.find((file) => file.id === activeFileId) : undefined
  const worktreeId = activeFile?.worktreeId
  const relativePath = activeFile?.relativePath
  const runtimeEnvironmentId = activeFile?.runtimeEnvironmentId ?? null
  // Why: while the buffer has unsaved edits its line numbers drift from the
  // on-disk file git blames, so blaming the cursor line would name the wrong
  // commit — hide until the file is saved.
  const isDirty = activeFile?.isDirty ?? false
  // Resolve the worktree root from store state (root-safe, unlike slicing the
  // file path). Reactive so a late-hydrating worktree list re-runs the effect.
  const worktreePath = useAppStore((s) => worktreePathFromState(s, worktreeId))

  // Clear authorship when the FILE changes so we never show another file's
  // author. We deliberately don't clear on same-file line moves: keeping the
  // prior line's blame during the debounce avoids the segment collapsing (and
  // the status bar reflowing) on every arrow-key press.
  React.useEffect(() => {
    setBlame(null)
  }, [worktreeId, relativePath])

  React.useEffect(() => {
    if (!relativePath || !worktreeId || !worktreePath || !cursorLine || isDirty) {
      setBlame(null)
      return
    }
    let cancelled = false
    // Why: debounce so scrubbing the cursor doesn't fire a git blame per line.
    const timer = setTimeout(() => {
      void getRuntimeGitLineBlame(
        {
          settings: settingsForRuntimeOwner(useAppStore.getState().settings, runtimeEnvironmentId),
          worktreeId,
          worktreePath,
          connectionId: getConnectionId(worktreeId) ?? undefined
        },
        { filePath: relativePath, line: cursorLine }
      )
        .then((result) => {
          if (!cancelled) {
            setBlame(result)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setBlame(null)
          }
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [relativePath, worktreeId, worktreePath, runtimeEnvironmentId, cursorLine, isDirty])

  if (!activeFile || !blame) {
    return null
  }

  const relative = formatRelative(blame.authorTimeMs)
  const label = blame.isUncommitted
    ? translate('auto.components.status.bar.LineBlameStatusSegment.uncommitted', 'Uncommitted')
    : relative
      ? `${blame.author} · ${relative}`
      : blame.author
  const fullDate = Number.isFinite(blame.authorTimeMs)
    ? new Date(blame.authorTimeMs).toLocaleString()
    : ''
  const tooltip = blame.isUncommitted
    ? translate(
        'auto.components.status.bar.LineBlameStatusSegment.uncommittedTooltip',
        'This line has uncommitted changes.'
      )
    : [blame.summary, `${blame.author}${fullDate ? `, ${fullDate}` : ''}`, blame.sha.slice(0, 7)]
        .filter(Boolean)
        .join(' — ')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-label={label}>
          <History className="size-3 shrink-0" />
          {iconOnly ? null : (
            <span className={compact ? 'max-w-[120px] truncate' : 'max-w-[200px] truncate'}>
              {label}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-sm">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
