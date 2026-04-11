import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  KEYBINDING_GROUPS,
  keyEventToCombo,
  parseKeyCombo,
  resolveKeybinding,
  type KeybindingActionId
} from '../../../../shared/keybindings'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

export const SHORTCUTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] =
  KEYBINDING_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      title: item.label,
      description: `${group.title} shortcut`,
      keywords: item.searchKeywords
    }))
  )

type ShortcutsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function KeyRecorder({
  currentCombo,
  isCustomized,
  onRecord,
  onReset
}: {
  currentCombo: string
  isCustomized: boolean
  onRecord: (combo: string) => void
  onReset: () => void
}): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const isMac = navigator.userAgent.includes('Mac')

  useEffect(() => {
    if (!recording) return

    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return

      if (e.key === 'Escape') {
        setRecording(false)
        return
      }

      const combo = keyEventToCombo(e, isMac)
      onRecord(combo)
      setRecording(false)
    }

    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [recording, isMac, onRecord])

  const displayKeys = parseKeyCombo(currentCombo, isMac)

  if (recording) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center rounded border border-ring bg-ring/10 px-2 py-0.5 text-xs font-medium text-foreground animate-pulse">
          Press keys...
        </span>
        <button
          onClick={() => setRecording(false)}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setRecording(true)}
        className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-accent"
        title="Click to change shortcut"
      >
        {displayKeys.map((key, kIdx) => (
          <React.Fragment key={kIdx}>
            <span className="inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
              {key}
            </span>
            {!isMac && kIdx < displayKeys.length - 1 ? (
              <span className="mx-0.5 text-xs text-muted-foreground">+</span>
            ) : null}
          </React.Fragment>
        ))}
      </button>
      {isCustomized ? (
        <button
          onClick={onReset}
          className="ml-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Reset to default"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  )
}

export function ShortcutsPane({
  settings,
  updateSettings
}: ShortcutsPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isMac = navigator.userAgent.includes('Mac')
  const customBindings = settings.keybindings ?? {}
  const hasAnyCustom = Object.keys(customBindings).length > 0

  const handleRecord = useCallback(
    (actionId: KeybindingActionId, combo: string) => {
      updateSettings({ keybindings: { ...customBindings, [actionId]: combo } })
    },
    [customBindings, updateSettings]
  )

  const handleReset = useCallback(
    (actionId: KeybindingActionId) => {
      const next = { ...customBindings }
      delete next[actionId]
      updateSettings({ keybindings: next })
    },
    [customBindings, updateSettings]
  )

  const handleResetAll = useCallback(() => {
    updateSettings({ keybindings: {} })
  }, [updateSettings])

  const groupEntries = useMemo<Record<string, SettingsSearchEntry[]>>(
    () =>
      Object.fromEntries(
        KEYBINDING_GROUPS.map((group) => [
          group.title,
          group.items.map((item) => ({
            title: item.label,
            description: `${group.title} shortcut`,
            keywords: item.searchKeywords
          }))
        ])
      ),
    []
  )

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
            <p className="text-xs text-muted-foreground">
              Customize keyboard shortcuts for common actions.
            </p>
          </div>
          {hasAnyCustom ? (
            <button
              onClick={handleResetAll}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              Reset All
            </button>
          ) : null}
        </div>

        <div className="grid gap-8">
          {KEYBINDING_GROUPS.filter((group) =>
            matchesSettingsSearch(searchQuery, groupEntries[group.title] ?? [])
          ).map((group) => (
            <div key={group.title} className="space-y-3">
              <h3 className="border-b border-border/50 pb-2 text-sm font-medium text-muted-foreground">
                {group.title}
              </h3>
              <div className="grid gap-2">
                {group.items.map((item) => {
                  const combo = resolveKeybinding(item.id, customBindings, isMac)
                  const isCustomized = item.id in customBindings

                  return (
                    <SearchableSetting
                      key={item.id}
                      title={item.label}
                      description={`${group.title} shortcut`}
                      keywords={item.searchKeywords}
                      className="flex items-center justify-between py-1"
                    >
                      <span className="text-sm text-foreground">{item.label}</span>
                      <KeyRecorder
                        currentCombo={combo}
                        isCustomized={isCustomized}
                        onRecord={(c) => handleRecord(item.id, c)}
                        onReset={() => handleReset(item.id)}
                      />
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
