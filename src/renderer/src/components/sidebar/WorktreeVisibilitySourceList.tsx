import React, { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  BuiltInWorktreeVisibilitySourceId,
  CustomWorktreeVisibilitySource,
  DetectedWorktree,
  Repo
} from '../../../../shared/types'
import {
  createWorktreeVisibilitySourceMatcher,
  effectiveBuiltInWorktreeSourceVisibility,
  effectiveCustomWorktreeSourceVisibility,
  normalizeCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatch
} from '../../../../shared/worktree-visibility-sources'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/external-worktree-visibility'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'

export type WorktreeVisibilitySourceRow =
  | { kind: 'built-in'; id: BuiltInWorktreeVisibilitySourceId }
  | { kind: 'custom'; source: CustomWorktreeVisibilitySource }
  | { kind: 'other' }

type Props = {
  repo: Repo
  worktrees: readonly DetectedWorktree[]
  disabled: boolean
  onAdd: (rootPath: string) => Promise<WorktreeVisibilitySourceAddResult>
  onRemove: (source: CustomWorktreeVisibilitySource) => Promise<void>
  onToggle: (source: WorktreeVisibilitySourceRow, enabled: boolean) => Promise<void>
}

export type WorktreeVisibilitySourceAddResult =
  | 'added'
  | 'invalid-path'
  | 'duplicate-path'
  | 'limit'
  | 'save-failed'

function getSourceLabel(source: WorktreeVisibilitySourceRow): string {
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

function isSourceEnabled(repo: Repo, source: WorktreeVisibilitySourceRow): boolean {
  if (source.kind === 'built-in') {
    return effectiveBuiltInWorktreeSourceVisibility(repo, source.id) === 'show'
  }
  if (source.kind === 'custom') {
    return effectiveCustomWorktreeSourceVisibility(repo, source.source.id) === 'show'
  }
  return (
    effectiveExternalWorktreeVisibility(repo, isLegacyRepoForExternalWorktreeVisibility(repo)) ===
    'show'
  )
}

function sourceMatchKey(match: WorktreeVisibilitySourceMatch | null): string {
  return match ? `${match.kind}:${match.id}` : 'other'
}

function sourceRowKey(source: WorktreeVisibilitySourceRow): string {
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
  worktrees,
  disabled,
  onAdd,
  onRemove,
  onToggle
}: Props): React.JSX.Element {
  const [rootPath, setRootPath] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const customSources = useMemo(
    () => normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? [],
    [repo.customWorktreeVisibilitySources]
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
        [repo.path, ...worktrees.map((worktree) => worktree.path)],
        customSources
      ),
    [customSources, repo.path, worktrees]
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

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault()
    setInputError(null)
    const result = await onAdd(rootPath)
    if (result === 'added') {
      setRootPath('')
      return
    }
    if (result === 'save-failed') {
      return
    }
    setInputError(
      result === 'limit'
        ? translate(
            'auto.components.sidebar.WorktreeVisibilitySourceList.limit',
            'Remove a custom location before adding another.'
          )
        : result === 'duplicate-path'
          ? translate(
              'auto.components.sidebar.WorktreeVisibilitySourceList.duplicatePath',
              'This location is already listed.'
            )
          : translate(
              'auto.components.sidebar.WorktreeVisibilitySourceList.invalidPath',
              'Enter an absolute path for this host.'
            )
    )
  }

  return (
    <section className="grid min-w-0 gap-2" aria-labelledby="worktree-sources-heading">
      <div>
        <h3 id="worktree-sources-heading" className="text-sm font-medium">
          {translate('auto.components.sidebar.WorktreeVisibilitySourceList.sources', 'Sources')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.sidebar.WorktreeVisibilitySourceList.sourcesDescription',
            'Enabled sources include current and future worktrees in the sidebar.'
          )}
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
        {sources.map((source, index) => {
          const label = getSourceLabel(source)
          const key = sourceRowKey(source)
          const count = sourceCounts.get(key) ?? 0
          const accessibleLabel = getAccessibleSourceLabel(source, label)
          return (
            <div
              key={key}
              className={`grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-2 ${index > 0 ? 'border-t border-border' : ''}`}
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{label}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {translate(
                      'auto.components.sidebar.WorktreeVisibilitySourceList.found',
                      '{{value0}} found',
                      { value0: count }
                    )}
                  </span>
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {getSourcePath(source)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {source.kind === 'custom' ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={disabled}
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
                <Switch
                  checked={isSourceEnabled(repo, source)}
                  disabled={disabled}
                  aria-label={translate(
                    'auto.components.sidebar.WorktreeVisibilitySourceList.toggle',
                    'Show current and future worktrees from {{value0}}',
                    { value0: accessibleLabel }
                  )}
                  onCheckedChange={(checked) => void onToggle(source, checked)}
                />
              </span>
            </div>
          )
        })}
        <form
          className="grid gap-2 border-t border-border bg-background/50 px-2.5 py-2.5"
          aria-label={translate(
            'auto.components.sidebar.WorktreeVisibilitySourceList.addLocation',
            'Add location'
          )}
          onSubmit={(event) => void handleAdd(event)}
        >
          <Label htmlFor="custom-worktree-root">
            {translate(
              'auto.components.sidebar.WorktreeVisibilitySourceList.worktreeRoot',
              'Worktree root'
            )}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="custom-worktree-root"
              className="font-mono text-xs"
              value={rootPath}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={inputError ? true : undefined}
              aria-describedby="custom-worktree-root-help"
              onChange={(event) => {
                setRootPath(event.target.value)
                setInputError(null)
              }}
            />
            <Button type="submit" size="sm" disabled={disabled || !rootPath.trim()}>
              {translate('auto.components.sidebar.WorktreeVisibilitySourceList.add', 'Add')}
            </Button>
          </div>
          <p
            id="custom-worktree-root-help"
            className={`text-[11px] ${inputError ? 'text-destructive' : 'text-muted-foreground'}`}
            role={inputError ? 'alert' : undefined}
          >
            {inputError ??
              translate(
                'auto.components.sidebar.WorktreeVisibilitySourceList.rootHelp',
                'Orca will recognize worktrees beneath this folder.'
              )}
          </p>
        </form>
      </div>
    </section>
  )
}
