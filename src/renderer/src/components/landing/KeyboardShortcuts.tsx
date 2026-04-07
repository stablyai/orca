import { useMemo } from 'react'

type ShortcutItem = {
  id: string
  keys: string[]
  action: string
}

function KeyCap({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      {label}
    </span>
  )
}

export default function KeyboardShortcuts(): React.JSX.Element {
  const shortcuts = useMemo<ShortcutItem[]>(
    () => [
      { id: 'create', keys: ['⌘', 'N'], action: 'Create worktree' },
      { id: 'up', keys: ['⌘', '⇧', '↑'], action: 'Move up worktree' },
      { id: 'down', keys: ['⌘', '⇧', '↓'], action: 'Move down worktree' }
    ],
    []
  )

  return (
    <div className="mt-6 w-full max-w-xs space-y-2">
      {shortcuts.map((shortcut) => (
        <div key={shortcut.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
          <span className="text-sm text-muted-foreground">{shortcut.action}</span>
          <div className="flex items-center gap-1">
            {shortcut.keys.map((key) => (
              <KeyCap key={`${shortcut.id}-${key}`} label={key} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
