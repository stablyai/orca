import { useMemo } from 'react'
import { useAppStore } from '../store'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { cn } from '../lib/utils'
import { ShortcutKeyCombo } from './ShortcutKeyCombo'

export function useWorkspaceCreateActionLabel(repos: readonly Repo[]): string {
  return repos.length > 0 && repos.every((repo) => isGitRepoKind(repo))
    ? translate('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
    : translate('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')
}

/** Workspace navigation hints shown on the Landing screen and as Home's footer. */
export function LandingShortcutHints({
  className,
  compact = false
}: {
  className?: string
  compact?: boolean
}): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const createActionLabel = useWorkspaceCreateActionLabel(repos)
  const moveUpLabel = translate('auto.components.Landing.moveUpWorkspace', 'Move up workspace')
  const moveDownLabel = translate(
    'auto.components.Landing.moveDownWorkspace',
    'Move down workspace'
  )
  const createWorktreeShortcut = useShortcutKeyDetails('workspace.create')
  const previousWorktreeShortcut = useShortcutKeyDetails('worktree.navigateUp')
  const nextWorktreeShortcut = useShortcutKeyDetails('worktree.navigateDown')
  const shortcuts = useMemo(
    () => [
      { id: 'create', shortcut: createWorktreeShortcut, action: createActionLabel },
      { id: 'up', shortcut: previousWorktreeShortcut, action: moveUpLabel },
      { id: 'down', shortcut: nextWorktreeShortcut, action: moveDownLabel }
    ],
    [
      createActionLabel,
      moveUpLabel,
      moveDownLabel,
      createWorktreeShortcut,
      nextWorktreeShortcut,
      previousWorktreeShortcut
    ]
  )

  return (
    <div
      className={cn(
        compact ? 'flex flex-wrap items-center gap-x-5 gap-y-2' : 'space-y-2',
        className
      )}
    >
      {shortcuts.map((shortcut) => (
        <div
          key={shortcut.id}
          className={cn('items-center gap-3', compact ? 'flex' : 'grid grid-cols-[1fr_auto]')}
        >
          <span className={cn('text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>
            {shortcut.action}
          </span>
          <ShortcutKeyCombo
            keys={shortcut.shortcut.keys}
            doubleTap={shortcut.shortcut.doubleTap}
            separatorClassName="mx-0.5 text-[10px] text-muted-foreground"
          />
        </div>
      ))}
    </div>
  )
}
