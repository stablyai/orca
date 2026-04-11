import React, { useMemo } from 'react'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

type ShortcutItem = {
  action: string
  keys: string[]
}

type ShortcutGroup = {
  title: string
  items: ShortcutItem[]
}

type ShortcutDefinition = {
  action: string
  searchKeywords: string[]
  keys: (labels: { mod: string; shift: string; enter: string }) => string[]
}

type ShortcutGroupDefinition = {
  title: string
  items: ShortcutDefinition[]
}

const SHORTCUT_GROUP_DEFINITIONS: ShortcutGroupDefinition[] = [
  {
    title: 'Global',
    items: [
      {
        action: 'Go to File',
        searchKeywords: ['shortcut', 'global', 'file'],
        keys: ({ mod }) => [mod, 'P']
      },
      {
        action: 'Switch worktree',
        searchKeywords: ['shortcut', 'global', 'worktree', 'switch', 'jump'],
        keys: ({ mod, shift }) => mod === '⌘' ? [mod, 'J'] : [mod, shift, 'J']
      },
      {
        action: 'Create worktree',
        searchKeywords: ['shortcut', 'global', 'worktree'],
        keys: ({ mod }) => [mod, 'N']
      },
      {
        action: 'Toggle Sidebar',
        searchKeywords: ['shortcut', 'sidebar'],
        keys: ({ mod }) => [mod, 'B']
      },
      {
        action: 'Toggle Right Sidebar',
        searchKeywords: ['shortcut', 'sidebar', 'right'],
        keys: ({ mod }) => [mod, 'L']
      },
      {
        action: 'Move up worktree',
        searchKeywords: ['shortcut', 'global', 'worktree', 'move'],
        keys: ({ mod, shift }) => [mod, shift, '↑']
      },
      {
        action: 'Move down worktree',
        searchKeywords: ['shortcut', 'global', 'worktree', 'move'],
        keys: ({ mod, shift }) => [mod, shift, '↓']
      },
      {
        action: 'Toggle File Explorer',
        searchKeywords: ['shortcut', 'file explorer'],
        keys: ({ mod, shift }) => [mod, shift, 'E']
      },
      {
        action: 'Toggle Search',
        searchKeywords: ['shortcut', 'search'],
        keys: ({ mod, shift }) => [mod, shift, 'F']
      },
      {
        action: 'Toggle Source Control',
        searchKeywords: ['shortcut', 'source control'],
        keys: ({ mod, shift }) => [mod, shift, 'G']
      },
      {
        action: 'Zoom In',
        searchKeywords: ['shortcut', 'zoom', 'in', 'scale'],
        keys: ({ mod, shift }) => (mod === 'Ctrl' ? [mod, shift, '+'] : [mod, '+'])
      },
      {
        action: 'Zoom Out',
        searchKeywords: ['shortcut', 'zoom', 'out', 'scale'],
        keys: ({ mod, shift }) => (mod === 'Ctrl' ? [mod, shift, '-'] : [mod, '-'])
      },
      {
        action: 'Reset Size',
        searchKeywords: ['shortcut', 'zoom', 'reset', 'size', 'actual'],
        keys: ({ mod }) => [mod, '0']
      },
      {
        action: 'Force Reload',
        searchKeywords: ['shortcut', 'reload', 'refresh', 'force'],
        keys: ({ mod, shift }) => [mod, shift, 'R']
      }
    ]
  },
  {
    title: 'Terminal Tabs',
    items: [
      {
        action: 'New tab',
        searchKeywords: ['shortcut', 'tab'],
        keys: ({ mod }) => [mod, 'T']
      },
      {
        action: 'Close active tab / pane',
        searchKeywords: ['shortcut', 'close', 'tab', 'pane'],
        keys: ({ mod }) => [mod, 'W']
      },
      {
        action: 'Next tab',
        searchKeywords: ['shortcut', 'tab', 'next'],
        keys: ({ mod, shift }) => [mod, shift, ']']
      },
      {
        action: 'Previous tab',
        searchKeywords: ['shortcut', 'tab', 'previous'],
        keys: ({ mod, shift }) => [mod, shift, '[']
      }
    ]
  },
  {
    title: 'Terminal Panes',
    items: [
      {
        action: 'Split pane right',
        searchKeywords: ['shortcut', 'pane', 'split'],
        keys: ({ mod }) => [mod, 'D']
      },
      {
        action: 'Split pane down',
        searchKeywords: ['shortcut', 'pane', 'split'],
        keys: ({ mod, shift }) => [mod, shift, 'D']
      },
      {
        action: 'Close pane (EOF)',
        searchKeywords: ['shortcut', 'pane', 'close', 'eof'],
        keys: () => ['Ctrl', 'D']
      },
      {
        action: 'Focus next pane',
        searchKeywords: ['shortcut', 'pane', 'focus', 'next'],
        keys: ({ mod }) => [mod, ']']
      },
      {
        action: 'Focus previous pane',
        searchKeywords: ['shortcut', 'pane', 'focus', 'previous'],
        keys: ({ mod }) => [mod, '[']
      },
      {
        action: 'Clear active pane',
        searchKeywords: ['shortcut', 'pane', 'clear'],
        keys: ({ mod }) => [mod, 'K']
      },
      {
        action: 'Expand / collapse pane',
        searchKeywords: ['shortcut', 'pane', 'expand', 'collapse'],
        keys: ({ mod, shift, enter }) => [mod, shift, enter]
      }
    ]
  }
]

// Why: search is supposed to stay in lockstep with the rendered shortcuts. Deriving
// both from one definition prevents the registry drift regression this branch introduced.
export const SHORTCUTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] =
  SHORTCUT_GROUP_DEFINITIONS.flatMap((group) =>
    group.items.map((item) => ({
      title: item.action,
      description: `${group.title} shortcut`,
      keywords: item.searchKeywords
    }))
  )

export function ShortcutsPane(): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isMac = navigator.userAgent.includes('Mac')
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const enter = isMac ? '↵' : 'Enter'

  const groups = useMemo<ShortcutGroup[]>(
    () =>
      SHORTCUT_GROUP_DEFINITIONS.map((group) => ({
        title: group.title,
        items: group.items.map((item) => ({
          action: item.action,
          keys: item.keys({ mod, shift, enter })
        }))
      })),
    [mod, shift, enter]
  )

  // Why: keywords here must match the ones used by SHORTCUTS_PANE_SEARCH_ENTRIES
  // (which uses searchKeywords from SHORTCUT_GROUP_DEFINITIONS). Using item.keys
  // (rendered key labels like ['Cmd', 'P']) would cause a mismatch where sidebar-level
  // search finds a shortcut but the inner SearchableSetting hides it.
  const groupEntries = useMemo<Record<string, SettingsSearchEntry[]>>(
    () =>
      Object.fromEntries(
        SHORTCUT_GROUP_DEFINITIONS.map((groupDef) => [
          groupDef.title,
          groupDef.items.map((defItem) => ({
            title: defItem.action,
            description: `${groupDef.title} shortcut`,
            keywords: defItem.searchKeywords
          }))
        ])
      ),
    []
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
          {groups
            .filter((group) => matchesSettingsSearch(searchQuery, groupEntries[group.title] ?? []))
            .map((group) => (
              <div key={group.title} className="space-y-3">
                <h3 className="border-b border-border/50 pb-2 text-sm font-medium text-muted-foreground">
                  {group.title}
                </h3>
                <div className="grid gap-2">
                  {group.items.map((item, idx) => {
                    // Why: look up the definition's searchKeywords so the inner
                    // SearchableSetting matches the same terms as the sidebar search.
                    const defGroup = SHORTCUT_GROUP_DEFINITIONS.find((g) => g.title === group.title)
                    const defItem = defGroup?.items.find((d) => d.action === item.action)
                    const keywords = defItem?.searchKeywords ?? item.keys

                    return (
                      <SearchableSetting
                        key={idx}
                        title={item.action}
                        description={`${group.title} shortcut`}
                        keywords={keywords}
                        className="flex items-center justify-between py-1"
                      >
                        <span className="text-sm text-foreground">{item.action}</span>
                        <div className="flex items-center gap-1">
                          {item.keys.map((key, kIdx) => (
                            <React.Fragment key={kIdx}>
                              <span className="inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
                                {key}
                              </span>
                              {!isMac && kIdx < item.keys.length - 1 ? (
                                <span className="mx-0.5 text-xs text-muted-foreground">+</span>
                              ) : null}
                            </React.Fragment>
                          ))}
                        </div>
                      </SearchableSetting>
                    )
                  })}
                </div>
              </div>
            ))}
        </div>
      </section>
    </div>
  )
}
