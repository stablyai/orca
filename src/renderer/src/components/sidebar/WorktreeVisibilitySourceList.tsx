import React, { useMemo } from 'react'
import { Info, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  BuiltInWorktreeVisibilitySourceId,
  CustomWorktreeVisibilitySource,
  ExternalWorktreeVisibility,
  Repo
} from '../../../../shared/repo-types'
import type { DetectedWorktree } from '../../../../shared/worktree/types'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import {
  createWorktreeVisibilitySourceMatcher,
  effectiveDefaultBuiltInWorktreeSourceVisibility,
  effectiveDefaultCustomWorktreeSourceVisibility,
  effectiveBuiltInWorktreeSourceVisibility,
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatch
} from '../../../../shared/worktree/visibility-sources'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/external-worktree-visibility'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import {
  getWorktreeVisibilityOverrideNotice,
  getWorktreeVisibilitySourceNote,
  getWorktreeVisibilitySourceProvenance,
  worktreeVisibilityValueLabel
} from './worktree-visibility-source-provenance'
import {
  WorktreeVisibilitySourceAddForm,
  type WorktreeVisibilitySourceAddResult
} from './WorktreeVisibilitySourceAddForm'

export type { WorktreeVisibilitySourceAddResult }

export type WorktreeVisibilitySourceRow =
  | { kind: 'built-in'; id: BuiltInWorktreeVisibilitySourceId }
  | { kind: 'custom'; source: CustomWorktreeVisibilitySource }
  | { kind: 'other' }

type Props = {
  repo?: Repo
  worktrees?: readonly DetectedWorktree[]
  visibilityDefaults?: WorktreeVisibilityDefaults
  customSources?: readonly CustomWorktreeVisibilitySource[]
  removableSourceIds?: ReadonlySet<string>
  showCounts?: boolean
  disabled: boolean
  sourceDefaultsDisabled?: boolean
  onAdd: (rootPath: string) => Promise<WorktreeVisibilitySourceAddResult>
  onRemove: (source: CustomWorktreeVisibilitySource) => Promise<void>
  onToggle: (source: WorktreeVisibilitySourceRow, enabled: boolean) => Promise<void>
  onUseDefault?: (source: WorktreeVisibilitySourceRow) => Promise<void>
}

const EMPTY_VISIBILITY_DEFAULTS: WorktreeVisibilityDefaults = {}
const EMPTY_WORKTREES: readonly DetectedWorktree[] = []
const VISIBILITY_SEGMENTS: readonly ExternalWorktreeVisibility[] = ['show', 'hide']

export function getWorktreeVisibilitySourceLabel(source: WorktreeVisibilitySourceRow): string {
  if (source.kind === 'built-in') {
    return source.id === 'claude'
      ? translate('auto.components.sidebar.WorktreeVisibilitySourceList.claude', 'Claude Code')
      : translate('auto.components.sidebar.WorktreeVisibilitySourceList.gsd', 'GSD')
  }
  if (source.kind === 'other') {
    return translate(
      'auto.components.sidebar.WorktreeVisibilitySourceList.other',
      'Other locations'
    )
  }
  return (
    getRuntimePathBasename(source.source.rootPath) ||
    translate('auto.components.sidebar.WorktreeVisibilitySourceList.custom', 'Custom location')
  )
}

function getSourcePath(source: WorktreeVisibilitySourceRow): string {
  if (source.kind === 'built-in') {
    return source.id === 'claude' ? '.claude/worktrees/*' : '.gsd-workspaces/*'
  }
  if (source.kind === 'other') {
    return translate(
      'auto.components.sidebar.WorktreeVisibilitySourceList.otherPath',
      'Outside listed sources'
    )
  }
  return `${source.source.rootPath.replace(/[\\/]+$/, '')}/*`
}

function sourceVisibility(
  repo: Repo | undefined,
  source: WorktreeVisibilitySourceRow,
  visibilityDefaults: WorktreeVisibilityDefaults,
  repoCustomSourceIds: ReadonlySet<string>
): ExternalWorktreeVisibility {
  if (source.kind === 'built-in') {
    return repo
      ? effectiveBuiltInWorktreeSourceVisibility(repo, source.id, visibilityDefaults)
      : effectiveDefaultBuiltInWorktreeSourceVisibility(visibilityDefaults, source.id)
  }
  if (source.kind === 'custom') {
    const explicit = repo
      ? normalizeWorktreeVisibilitySourcePreferences(repo.worktreeVisibilitySourcePreferences)
          ?.custom?.[source.source.id]
      : undefined
    return (
      explicit ??
      (repoCustomSourceIds.has(source.source.id)
        ? 'hide'
        : effectiveDefaultCustomWorktreeSourceVisibility(visibilityDefaults, source.source.id))
    )
  }
  return effectiveExternalWorktreeVisibility(
    repo ?? {},
    repo ? isLegacyRepoForExternalWorktreeVisibility(repo) : false,
    visibilityDefaults
  )
}

function sourceMatchKey(match: WorktreeVisibilitySourceMatch | null): string {
  return match ? `${match.kind}:${match.id}` : 'other'
}

export function worktreeVisibilitySourceRowKey(source: WorktreeVisibilitySourceRow): string {
  return source.kind === 'custom'
    ? `custom:${source.source.id}`
    : source.kind === 'built-in'
      ? `built-in:${source.id}`
      : 'other'
}

function getAccessibleSourceLabel(source: WorktreeVisibilitySourceRow, label: string): string {
  return source.kind === 'custom' ? source.source.rootPath : label
}

export default function WorktreeVisibilitySourceList({
  repo,
  worktrees = EMPTY_WORKTREES,
  visibilityDefaults = EMPTY_VISIBILITY_DEFAULTS,
  customSources: providedCustomSources,
  removableSourceIds,
  showCounts = true,
  disabled,
  sourceDefaultsDisabled = false,
  onAdd,
  onRemove,
  onToggle,
  onUseDefault
}: Props): React.JSX.Element {
  const customSources = useMemo(
    () =>
      normalizeCustomWorktreeVisibilitySources(
        providedCustomSources ??
          (repo
            ? resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults)
            : visibilityDefaults.customSources)
      ) ?? [],
    [providedCustomSources, repo, visibilityDefaults]
  )
  const repoCustomSourceIds = useMemo(
    () =>
      new Set(
        normalizeCustomWorktreeVisibilitySources(repo?.customWorktreeVisibilitySources)?.map(
          (source) => source.id
        ) ?? []
      ),
    [repo?.customWorktreeVisibilitySources]
  )
  const sources = useMemo<WorktreeVisibilitySourceRow[]>(
    () => [
      { kind: 'built-in', id: 'claude' },
      { kind: 'built-in', id: 'gsd' },
      ...customSources.map((source) => ({ kind: 'custom' as const, source })),
      { kind: 'other' }
    ],
    [customSources]
  )
  const classify = useMemo(
    () =>
      createWorktreeVisibilitySourceMatcher(
        [...(repo ? [repo.path] : []), ...worktrees.map((worktree) => worktree.path)],
        customSources
      ),
    [customSources, repo, worktrees]
  )
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const worktree of worktrees) {
      if (worktree.selectedCheckout || worktree.ownership === 'orca-managed') {
        continue
      }
      const key = sourceMatchKey(worktree.visibilitySource ?? classify(worktree.path))
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [classify, worktrees])

  return (
    <section className="grid min-w-0 gap-2" aria-labelledby="worktree-sources-heading">
      <div>
        <h3 id="worktree-sources-heading" className="text-sm font-medium">
          {translate('auto.components.sidebar.WorktreeVisibilitySourceList.sources', 'Sources')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.sidebar.WorktreeVisibilitySourceList.sourcesDescription',
            'Shown sources include current and future worktrees in the sidebar.'
          )}
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
        {sources.map((source, index) => {
          const label = getWorktreeVisibilitySourceLabel(source)
          const key = worktreeVisibilitySourceRowKey(source)
          const count = sourceCounts.get(key) ?? 0
          const accessibleLabel = getAccessibleSourceLabel(source, label)
          const sourceDisabled = disabled || (source.kind !== 'other' && sourceDefaultsDisabled)
          const provenance = getWorktreeVisibilitySourceProvenance(
            repo,
            source,
            visibilityDefaults,
            repoCustomSourceIds
          )
          const visibility = sourceVisibility(repo, source, visibilityDefaults, repoCustomSourceIds)
          const note = getWorktreeVisibilitySourceNote(provenance)
          const overrideNotice = getWorktreeVisibilityOverrideNotice(provenance, visibility)
          const matchingOverride =
            provenance?.kind === 'project-override' && provenance.globalVisibility === visibility
          return (
            <div
              key={key}
              data-source-row={key}
              className={`grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 px-2.5 py-2 ${index > 0 ? 'border-t border-border' : ''}`}
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{label}</span>
                  {showCounts ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {translate(
                        'auto.components.sidebar.WorktreeVisibilitySourceList.found',
                        '{{value0}} found',
                        { value0: count }
                      )}
                    </span>
                  ) : null}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {getSourcePath(source)}
                </span>
                {note ? (
                  <span className="block text-[11px] text-muted-foreground">{note}</span>
                ) : null}
              </span>
              <span className="flex items-center gap-1">
                {source.kind === 'custom' &&
                (!removableSourceIds || removableSourceIds.has(source.source.id)) ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={sourceDisabled}
                        aria-label={translate(
                          'auto.components.sidebar.WorktreeVisibilitySourceList.remove',
                          'Remove {{value0}}',
                          { value0: accessibleLabel }
                        )}
                        onClick={() => void onRemove(source.source)}
                      >
                        <Trash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {translate(
                        'auto.components.sidebar.WorktreeVisibilitySourceList.removeLocation',
                        'Remove custom location'
                      )}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {matchingOverride && onUseDefault ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-auto px-1"
                    disabled={sourceDisabled}
                    aria-label={translate(
                      'auto.components.sidebar.WorktreeVisibilitySourceList.useGlobalFor',
                      'Use global for {{value0}}',
                      { value0: accessibleLabel }
                    )}
                    onClick={() => void onUseDefault(source)}
                  >
                    {translate(
                      'auto.components.sidebar.WorktreeVisibilitySourceList.useGlobal',
                      'Use global'
                    )}
                  </Button>
                ) : null}
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={visibility}
                  disabled={sourceDisabled}
                  aria-label={translate(
                    'auto.components.sidebar.WorktreeVisibilitySourceList.visibility',
                    'Visibility for {{value0}}',
                    { value0: accessibleLabel }
                  )}
                  className="h-7"
                  onValueChange={(next) => {
                    // Why: re-picking the selected segment clears Radix's value; it is not a change.
                    if (next === 'show' || next === 'hide') {
                      void onToggle(source, next === 'show')
                    }
                  }}
                >
                  {VISIBILITY_SEGMENTS.map((segment) => (
                    <ToggleGroupItem
                      key={segment}
                      value={segment}
                      data-visibility={segment}
                      className="h-7 min-w-11 px-2 text-[11px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
                    >
                      {worktreeVisibilityValueLabel(segment)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </span>
              {overrideNotice ? (
                <span
                  role="status"
                  className="col-span-2 flex items-start gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5 text-[11px] leading-relaxed"
                >
                  <Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                  {overrideNotice}
                </span>
              ) : null}
            </div>
          )
        })}
        <WorktreeVisibilitySourceAddForm
          disabled={disabled || sourceDefaultsDisabled}
          onAdd={onAdd}
        />
      </div>
    </section>
  )
}
