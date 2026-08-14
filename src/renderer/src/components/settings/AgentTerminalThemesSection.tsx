import { useMemo, useState } from 'react'
import type React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import {
  AGENT_TERMINAL_THEME_INHERIT,
  normalizeAgentTerminalThemes,
  resolveAgentThemeSelection,
  upsertAgentTerminalThemeSlot
} from '../../../../shared/agent-terminal-themes'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getTerminalThemePreview } from '@/lib/terminal-theme'
import { Button } from '../ui/button'
import { AppearanceAdvancedDisclosure } from './AppearanceAdvancedDisclosure'
import { SearchableSetting } from './SearchableSetting'
import { ThemePicker } from './TerminalThemePicker'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'
import { AgentTerminalThemeRow } from './AgentTerminalThemeRow'
import {
  getAgentTerminalThemeOptions,
  getAgentTerminalThemeSelectionLabel
} from './agent-terminal-theme-options'
import {
  collectAgentTerminalThemeRows,
  collectCachedDetectedAgentIds,
  isAgentTerminalThemeRowsEmptySuccess,
  isAgentTerminalThemeRowsFailed,
  isAgentTerminalThemeRowsLoading
} from './agent-terminal-theme-rows'
import { getAgentTerminalThemeSearchEntries } from './agent-terminal-theme-search'

type AgentTerminalThemesSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  target: 'dark' | 'light'
}

export function AgentTerminalThemesSection({
  settings,
  updateSettings,
  target
}: AgentTerminalThemesSectionProps): React.JSX.Element {
  const { detectedIds, isLoading, detectionFailed, refresh } = useDetectedAgents({ kind: 'local' })
  const remoteDetectedAgentIds = useAppStore((state) => state.remoteDetectedAgentIds)
  const runtimeDetectedAgentIds = useAppStore((state) => state.runtimeDetectedAgentIds)
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const [expandedAgent, setExpandedAgent] = useState<TuiAgent | null>(null)
  const [themeSearch, setThemeSearch] = useState('')
  const searchEntry = getAgentTerminalThemeSearchEntries()[0]
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const searchMatches =
    isSearching && searchEntry != null && matchesSettingsSearch(searchQuery, searchEntry)
  const themeOptions = useMemo(() => getAgentTerminalThemeOptions(settings), [settings])
  const persistedKeys = Object.keys(settings.agentTerminalThemes ?? {})
  const cachedDetectedIds = collectCachedDetectedAgentIds([
    remoteDetectedAgentIds,
    runtimeDetectedAgentIds
  ])
  const rows = collectAgentTerminalThemeRows(
    {
      localDetectedIds: detectedIds,
      remoteDetectedAgentIds,
      runtimeDetectedAgentIds
    },
    persistedKeys,
    settings.disabledTuiAgents
  )
  const loading = isAgentTerminalThemeRowsLoading({
    localDetectedIds: detectedIds,
    isLoading,
    persistedKeyCount: persistedKeys.length,
    cachedDetectedIds
  })
  const failed = isAgentTerminalThemeRowsFailed({
    localDetectedIds: detectedIds,
    isLoading,
    detectionFailed,
    rowCount: rows.length
  })
  const emptySuccess = isAgentTerminalThemeRowsEmptySuccess({
    localDetectedIds: detectedIds,
    rowCount: rows.length,
    persistedKeyCount: persistedKeys.length
  })

  const title = translate(
    'auto.components.settings.AgentTerminalThemes.title',
    'Agent terminal themes'
  )
  const description = translate(
    'auto.components.settings.AgentTerminalThemes.description',
    'Shells and unset agents use the global Dark/Light themes. App chrome does not follow the agent. Paired-server background workers are not themed in phase 1.'
  )
  const oneLineDescription =
    searchEntry?.description ??
    translate(
      'auto.components.settings.terminal.search.agent_themes.description',
      'Override the global terminal theme for a specific agent.'
    )
  const overrideCount = Object.keys(
    normalizeAgentTerminalThemes(settings.agentTerminalThemes)
  ).length
  const overrideSummary =
    overrideCount === 0
      ? null
      : overrideCount === 1
        ? translate(
            'auto.components.settings.AgentTerminalThemes.override_count_one',
            '1 override'
          )
        : translate(
            'auto.components.settings.AgentTerminalThemes.override_count_other',
            '{{value0}} overrides',
            { value0: overrideCount }
          )

  return (
    <SearchableSetting
      title={searchEntry?.title ?? title}
      description={searchEntry?.description ?? description}
      keywords={searchEntry?.keywords ?? []}
      forceVisible
    >
      <AppearanceAdvancedDisclosure
        label={title}
        description={oneLineDescription}
        summary={overrideSummary}
        forceOpen={searchMatches}
        showTopBorder={false}
        className="mt-0 pt-0"
        contentClassName="space-y-3 pt-2"
      >
        {loading ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AgentTerminalThemes.detecting',
              'Detecting agents…'
            )}
          </p>
        ) : null}
        {failed ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span className="flex min-w-0 items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {translate(
                'auto.components.settings.AgentTerminalThemes.detection_failed',
                'Couldn’t detect installed agents. Check the host connection and try again.'
              )}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void refresh()}
              className="h-6 shrink-0 gap-1.5 px-2 text-destructive hover:text-destructive"
            >
              <RefreshCw className="size-3" />
              {translate('auto.components.settings.AgentTerminalThemes.retry', 'Retry')}
            </Button>
          </div>
        ) : null}
        {emptySuccess ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AgentTerminalThemes.empty',
              'No enabled agents detected. Enable an agent in Settings → Agents.'
            )}
          </p>
        ) : null}
        {rows.length > 0 ? (
          <div className="space-y-1">
            {rows.map((row) => {
              const selectedTheme =
                settings.agentTerminalThemes?.[row.id]?.[target] ?? AGENT_TERMINAL_THEME_INHERIT
              const resolvedName = resolveAgentThemeSelection(settings, target, row.id)
              return (
                <AgentTerminalThemeRow
                  key={row.id}
                  agent={row.id}
                  disabled={row.disabled}
                  expanded={expandedAgent === row.id}
                  selectionLabel={getAgentTerminalThemeSelectionLabel(themeOptions, selectedTheme)}
                  previewTheme={getTerminalThemePreview(resolvedName, settings, target)}
                  onToggle={() => {
                    setThemeSearch('')
                    setExpandedAgent((current) => (current === row.id ? null : row.id))
                  }}
                >
                  <ThemePicker
                    selectedTheme={selectedTheme}
                    themeOptions={themeOptions}
                    query={themeSearch}
                    onQueryChange={setThemeSearch}
                    onSelectTheme={(theme) => {
                      updateSettings({
                        agentTerminalThemes: upsertAgentTerminalThemeSlot(
                          settings.agentTerminalThemes,
                          row.id,
                          target,
                          theme
                        )
                      })
                    }}
                  />
                </AgentTerminalThemeRow>
              )
            })}
          </div>
        ) : null}
      </AppearanceAdvancedDisclosure>
    </SearchableSetting>
  )
}
