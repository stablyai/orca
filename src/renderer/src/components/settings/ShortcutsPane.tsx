import React, { useEffect, useMemo } from 'react'
import { ExternalLink, FolderOpen, RefreshCw } from 'lucide-react'
import { useAppStore } from '../../store'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { Button } from '../ui/button'
import { formatCanonicalChordLabel } from '../../../../shared/keybindings/keybinding-display'
import { keybindingCatalog } from '../../../../shared/keybindings/keybinding-catalog'
import type {
  EffectiveKeybinding,
  KeybindingActionId
} from '../../../../shared/keybindings/keybinding-types'

type KeybindingGroupDefinition = {
  title: string
  matches: (id: KeybindingActionId) => boolean
}

type EffectiveBindingView = {
  id: KeybindingActionId
  title: string
  source: EffectiveKeybinding['source']
  groupTitle: string
  searchEntry: SettingsSearchEntry
  chordLabels: string[]
}

const KEYBINDING_GROUPS: KeybindingGroupDefinition[] = [
  { title: 'Global', matches: (id) => /^(window|worktree|sidebar|quickOpen|workspace)\./.test(id) },
  { title: 'Tabs', matches: (id) => id.startsWith('tab.') || id.endsWith('.tab.new') },
  { title: 'Browser', matches: (id) => id.startsWith('browser.') },
  { title: 'Terminal', matches: (id) => id.startsWith('terminal.') },
  { title: 'Editors', matches: (id) => id.startsWith('editor.') }
]

const KEYBINDINGS_TOML_EXAMPLE = `[keybindings.linux]
"terminal.paste" = ["ctrl+shift+v", "shift+insert"]
"browser.tab.new" = "ctrl+shift+b"

[keybindings.macos]
"terminal.paste" = "cmd+v"

[keybindings.windows]
"terminal.paste" = "ctrl+shift+v"`

function groupTitleForAction(id: KeybindingActionId): string {
  return KEYBINDING_GROUPS.find((group) => group.matches(id))?.title ?? 'Other'
}

function searchEntryForBinding(
  id: KeybindingActionId,
  title: string,
  groupTitle: string
): SettingsSearchEntry {
  return {
    title,
    description: `${groupTitle} keybinding`,
    keywords: ['shortcut', 'keybinding', id, ...id.split('.')]
  }
}

export const SHORTCUTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = keybindingCatalog.map((entry) =>
  searchEntryForBinding(entry.id, entry.title, groupTitleForAction(entry.id))
)

export function ShortcutsPane(): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const keybindingSnapshot = useAppStore((state) => state.keybindingSnapshot)
  const fetchKeybindings = useAppStore((state) => state.fetchKeybindings)
  const reloadKeybindings = useAppStore((state) => state.reloadKeybindings)

  const effectiveBindings = useMemo<EffectiveBindingView[]>(
    () =>
      keybindingSnapshot?.keymap.bindings.map((binding) => ({
        id: binding.id,
        title: binding.title,
        source: binding.source,
        groupTitle: groupTitleForAction(binding.id),
        searchEntry: searchEntryForBinding(
          binding.id,
          binding.title,
          groupTitleForAction(binding.id)
        ),
        chordLabels:
          binding.chords.length === 0
            ? ['Unbound']
            : binding.chords.map((chord) =>
                formatCanonicalChordLabel(chord, keybindingSnapshot.keymap.platform)
              )
      })) ?? [],
    [keybindingSnapshot]
  )

  const groupedBindings = useMemo(
    () =>
      [...KEYBINDING_GROUPS.map((group) => group.title), 'Other']
        .map((title) => ({
          title,
          items: effectiveBindings.filter((binding) => binding.groupTitle === title)
        }))
        .filter((group) => group.items.length > 0),
    [effectiveBindings]
  )

  useEffect(() => {
    if (!keybindingSnapshot) {
      void fetchKeybindings()
    }
  }, [fetchKeybindings, keybindingSnapshot])

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
        </div>

        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-muted-foreground">Config file</div>
              <div className="truncate font-mono text-sm">
                {keybindingSnapshot?.displayPath ?? '~/.orca/keybindings.toml'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void window.api.keybindings.openConfig()}
              >
                <ExternalLink />
                Open
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void window.api.keybindings.revealConfig()}
              >
                <FolderOpen />
                Reveal
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void reloadKeybindings()}
              >
                <RefreshCw />
                Reload
              </Button>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {keybindingSnapshot?.fileState === 'missing'
              ? 'No keybindings file exists yet. Open will create a starter TOML file.'
              : `Last loaded ${keybindingSnapshot?.keymap.diagnostics.length ?? 0} diagnostic(s).`}
          </div>
          {keybindingSnapshot && keybindingSnapshot.keymap.diagnostics.length > 0 ? (
            <div className="space-y-1 border-t border-border/50 pt-2">
              {keybindingSnapshot.keymap.diagnostics.map((diagnostic, index) => (
                <div key={index} className="text-xs text-destructive">
                  {diagnostic.message}
                </div>
              ))}
            </div>
          ) : null}
          <div className="border-t border-border/50 pt-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Example</div>
            <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs text-muted-foreground">
              {KEYBINDINGS_TOML_EXAMPLE}
            </pre>
          </div>
        </div>

        <div className="grid gap-8">
          {groupedBindings
            .filter((group) =>
              matchesSettingsSearch(
                searchQuery,
                group.items.map((binding) => binding.searchEntry)
              )
            )
            .map((group) => (
              <div key={group.title} className="space-y-3">
                <h3 className="border-b border-border/50 pb-2 text-sm font-medium text-muted-foreground">
                  {group.title}
                </h3>
                <div className="grid gap-2">
                  {group.items.map((binding) => (
                    <SearchableSetting
                      key={binding.id}
                      title={binding.title}
                      description={binding.searchEntry.description}
                      keywords={binding.searchEntry.keywords}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-foreground">{binding.title}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {binding.id} · {binding.source}
                        </div>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        {binding.chordLabels.map((label) =>
                          label === 'Unbound' ? (
                            <span key={label} className="text-xs text-muted-foreground">
                              Unbound
                            </span>
                          ) : (
                            <ShortcutKeyCombo key={label} keys={label.split('+')} />
                          )
                        )}
                      </div>
                    </SearchableSetting>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </section>
    </div>
  )
}
