import React, { useMemo } from 'react'

type ShortcutItem = {
  action: string
  keys: string[]
}

type ShortcutGroup = {
  title: string
  items: ShortcutItem[]
}

export function ShortcutsPane(): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const enter = isMac ? '↵' : 'Enter'

  const groups = useMemo<ShortcutGroup[]>(
    () => [
      {
        title: 'Global',
        items: [
          { action: 'Go to File', keys: [mod, 'P'] },
          { action: 'Create worktree', keys: [mod, 'N'] },
          { action: 'Toggle Sidebar', keys: [mod, 'B'] },
          { action: 'Move up worktree', keys: [mod, shift, '↑'] },
          { action: 'Move down worktree', keys: [mod, shift, '↓'] },
          { action: 'Toggle File Explorer', keys: [mod, shift, 'E'] },
          { action: 'Toggle Search', keys: [mod, shift, 'F'] },
          { action: 'Toggle Source Control', keys: [mod, shift, 'G'] }
        ]
      },
      {
        title: 'Terminal Tabs',
        items: [
          { action: 'New tab', keys: [mod, 'T'] },
          { action: 'Close active tab / pane', keys: [mod, 'W'] },
          { action: 'Next tab', keys: [mod, shift, ']'] },
          { action: 'Previous tab', keys: [mod, shift, '['] }
        ]
      },
      {
        title: 'Terminal Panes',
        items: [
          { action: 'Split pane right', keys: [mod, 'D'] },
          { action: 'Split pane down', keys: [mod, shift, 'D'] },
          { action: 'Close pane (EOF)', keys: ['Ctrl', 'D'] },
          { action: 'Focus next pane', keys: [mod, ']'] },
          { action: 'Focus previous pane', keys: [mod, '['] },
          { action: 'Clear active pane', keys: [mod, 'K'] },
          { action: 'Expand / collapse pane', keys: [mod, shift, enter] }
        ]
      }
    ],
    [mod, shift, enter]
  )

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
          <p className="text-xs text-muted-foreground">
            View common hotkeys used across the application. Shortcuts customization is not
            currently supported.
          </p>
        </div>

        <div className="grid gap-8">
          {groups.map((group) => (
            <div key={group.title} className="space-y-3">
              <h3 className="text-sm font-medium border-b border-border/50 pb-2 text-muted-foreground">
                {group.title}
              </h3>
              <div className="grid gap-2">
                {group.items.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1">
                    <span className="text-sm text-foreground">{item.action}</span>
                    <div className="flex items-center gap-1">
                      {item.keys.map((key, kIdx) => (
                        <React.Fragment key={kIdx}>
                          <span className="inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
                            {key}
                          </span>
                          {!isMac && kIdx < item.keys.length - 1 && (
                            <span className="text-muted-foreground text-xs mx-0.5">+</span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
