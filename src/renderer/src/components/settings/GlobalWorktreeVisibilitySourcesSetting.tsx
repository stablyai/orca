import { useCallback, useMemo, useRef, useState } from 'react'
import type { CustomWorktreeVisibilitySource } from '../../../../shared/repo-types'
import type {
  GlobalSettings,
  WorktreeVisibilityDefaults
} from '../../../../shared/global-settings-types'
import {
  MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES,
  normalizeCustomWorktreeVisibilitySources
} from '../../../../shared/worktree/visibility-sources'
import {
  buildDefaultWorktreeSourcePreferenceUpdate,
  removeDefaultCustomWorktreeSourcePreference
} from '../../../../shared/worktree/visibility-source-preferences'
import WorktreeVisibilitySourceList, {
  type WorktreeVisibilitySourceAddResult,
  type WorktreeVisibilitySourceRow
} from '../sidebar/WorktreeVisibilitySourceList'
import { translate } from '@/i18n/i18n'

type Props = {
  settings: GlobalSettings
  defaultsSupported: boolean
  sourceDefaultsSupported: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

const DEFAULT_WORKTREE_VISIBILITY_DEFAULTS: WorktreeVisibilityDefaults = { external: 'hide' }

export function GlobalWorktreeVisibilitySourcesSetting({
  settings,
  defaultsSupported,
  sourceDefaultsSupported,
  updateSettings
}: Props): React.JSX.Element {
  const defaults = settings.worktreeVisibilityDefaults ?? DEFAULT_WORKTREE_VISIBILITY_DEFAULTS
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const customSources = useMemo(
    () => normalizeCustomWorktreeVisibilitySources(defaults.customSources) ?? [],
    [defaults.customSources]
  )
  const removableSourceIds = useMemo(
    () => new Set(customSources.map((source) => source.id)),
    [customSources]
  )

  const commit = useCallback(
    async (next: WorktreeVisibilityDefaults): Promise<boolean> => {
      if (pendingRef.current) {
        return false
      }
      pendingRef.current = true
      setPending(true)
      setError(null)
      try {
        await updateSettings({ worktreeVisibilityDefaults: next })
        return true
      } catch {
        setError(
          translate(
            'auto.components.settings.GlobalWorktreeVisibilitySourcesSetting.saveFailed',
            'Could not save visibility defaults.'
          )
        )
        return false
      } finally {
        pendingRef.current = false
        setPending(false)
      }
    },
    [updateSettings]
  )

  const handleToggle = useCallback(
    async (source: WorktreeVisibilitySourceRow, checked: boolean) => {
      const visibility = checked ? 'show' : 'hide'
      if (source.kind === 'other') {
        await commit(
          sourceDefaultsSupported ? { ...defaults, external: visibility } : { external: visibility }
        )
        return
      }
      if (!sourceDefaultsSupported) {
        return
      }
      const match =
        source.kind === 'built-in'
          ? ({ kind: 'built-in', id: source.id } as const)
          : ({ kind: 'custom', id: source.source.id } as const)
      await commit({
        ...defaults,
        sourcePreferences: buildDefaultWorktreeSourcePreferenceUpdate(defaults, match, visibility)
      })
    },
    [commit, defaults, sourceDefaultsSupported]
  )

  const handleAdd = useCallback(
    async (rootPath: string): Promise<WorktreeVisibilitySourceAddResult> => {
      if (!sourceDefaultsSupported) {
        return 'save-failed'
      }
      if (customSources.length >= MAX_CUSTOM_WORKTREE_VISIBILITY_SOURCES) {
        return 'limit'
      }
      const id = crypto.randomUUID().replaceAll('-', '')
      const candidate = normalizeCustomWorktreeVisibilitySources([{ id, rootPath }])?.[0]
      if (!candidate) {
        return 'invalid-path'
      }
      const nextSources = normalizeCustomWorktreeVisibilitySources([...customSources, candidate])
      if (!nextSources || nextSources.length !== customSources.length + 1) {
        return 'duplicate-path'
      }
      const saved = await commit({
        ...defaults,
        customSources: nextSources,
        sourcePreferences: buildDefaultWorktreeSourcePreferenceUpdate(
          defaults,
          { kind: 'custom', id },
          'hide'
        )
      })
      return saved ? 'added' : 'save-failed'
    },
    [commit, customSources, defaults, sourceDefaultsSupported]
  )

  const handleRemove = useCallback(
    async (source: CustomWorktreeVisibilitySource) => {
      if (!sourceDefaultsSupported) {
        return
      }
      await commit({
        ...defaults,
        customSources: customSources.filter((candidate) => candidate.id !== source.id),
        sourcePreferences: removeDefaultCustomWorktreeSourcePreference(defaults, source.id)
      })
    },
    [commit, customSources, defaults, sourceDefaultsSupported]
  )

  return (
    <div className="space-y-2">
      <WorktreeVisibilitySourceList
        visibilityDefaults={defaults}
        customSources={customSources}
        removableSourceIds={removableSourceIds}
        showCounts={false}
        disabled={pending || !defaultsSupported}
        sourceDefaultsDisabled={!sourceDefaultsSupported}
        onAdd={handleAdd}
        onRemove={handleRemove}
        onToggle={handleToggle}
      />
      {!defaultsSupported ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GlobalWorktreeVisibilitySourcesSetting.updateServerDefaults',
            'Update this server to configure visibility defaults.'
          )}
        </p>
      ) : !sourceDefaultsSupported ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GlobalWorktreeVisibilitySourcesSetting.updateServer',
            'Update this server to configure source defaults.'
          )}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
