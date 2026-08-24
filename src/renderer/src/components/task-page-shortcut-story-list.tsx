import React, { useMemo, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { ShortcutStory, ShortcutWorkflow } from '../../../shared/shortcut-types'
import { shortcutStoryReference } from '../../../shared/shortcut-story-reference'

export type TaskPageShortcutStorySection = {
  key: string
  label: string
  stories: ShortcutStory[]
}

type TaskPageShortcutStoryListProps = {
  formatUpdatedAt: (updatedAt: string) => string
  getStateTone: (stateType: ShortcutStory['state']['type']) => string
  stories: ShortcutStory[]
  onOpenStory: (story: ShortcutStory) => void
  onStartWorkspace: (story: ShortcutStory) => void
  selectedStory: ShortcutStory | null
  showWorkspaceContext: boolean
  workflows: readonly ShortcutWorkflow[]
}

function statePositionRanks(workflows: readonly ShortcutWorkflow[]): Map<string, number> {
  const ranks = new Map<string, number>()
  for (const workflow of workflows) {
    for (const [index, state] of workflow.states.entries()) {
      if (!ranks.has(state.id)) {
        ranks.set(state.id, index)
      }
    }
  }
  return ranks
}

function sectionRank(
  section: TaskPageShortcutStorySection,
  ranks: ReadonlyMap<string, number>
): number {
  let rank = Number.POSITIVE_INFINITY
  for (const story of section.stories) {
    rank = Math.min(rank, ranks.get(story.state.id) ?? Number.POSITIVE_INFINITY)
  }
  return rank
}

export function groupShortcutStoriesByState(
  stories: readonly ShortcutStory[],
  workflows: readonly ShortcutWorkflow[]
): TaskPageShortcutStorySection[] {
  const sections = new Map<string, TaskPageShortcutStorySection>()
  for (const story of stories) {
    const key = `state:${story.state.name}`
    const section = sections.get(key)
    if (section) {
      section.stories.push(story)
    } else {
      sections.set(key, { key, label: story.state.name, stories: [story] })
    }
  }

  const ranks = statePositionRanks(workflows)
  const sectionRanks = new Map(
    [...sections.values()].map((section) => [section.key, sectionRank(section, ranks)])
  )
  return [...sections.values()].sort((a, b) => {
    const rankA = sectionRanks.get(a.key) ?? Number.POSITIVE_INFINITY
    const rankB = sectionRanks.get(b.key) ?? Number.POSITIVE_INFINITY
    return rankA === rankB ? a.label.localeCompare(b.label) : rankA - rankB
  })
}

function isSelectedStory(story: ShortcutStory, selectedStory: ShortcutStory | null): boolean {
  if (!selectedStory || story.id !== selectedStory.id) {
    return false
  }
  return (
    !selectedStory.workspaceId ||
    !story.workspaceId ||
    selectedStory.workspaceId === story.workspaceId
  )
}

function ShortcutStoryRow({
  formatUpdatedAt,
  getStateTone,
  story,
  onOpenStory,
  onStartWorkspace,
  selected,
  showWorkspaceContext
}: {
  formatUpdatedAt: (updatedAt: string) => string
  getStateTone: (stateType: ShortcutStory['state']['type']) => string
  story: ShortcutStory
  onOpenStory: (story: ShortcutStory) => void
  onStartWorkspace: (story: ShortcutStory) => void
  selected: boolean
  showWorkspaceContext: boolean
}): React.JSX.Element {
  const labels = story.labels.slice(0, 3)
  const owner = story.owners[0]
  const contextLabel =
    showWorkspaceContext && story.workspaceName
      ? `${story.workspaceName}${story.team ? ` / ${story.team.name}` : ''}`
      : (story.team?.name ?? '')
  const reference = shortcutStoryReference(story)

  return (
    // Why: the row contains action buttons, so a native button wrapper would
    // create invalid nested buttons; role + keyboard handling preserves access.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      data-current={selected ? 'true' : undefined}
      onClick={() => onOpenStory(story)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenStory(story)
        }
      }}
      className={cn(
        'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[90px_minmax(0,1fr)_128px_92px_80px_64px] lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_128px_72px]',
        selected && 'bg-accent'
      )}
    >
      <span className="block truncate font-mono text-[12px] text-muted-foreground max-md:!hidden">
        {reference}
      </span>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground md:hidden">
            {reference}
          </span>
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
            {story.title}
          </h3>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 md:!hidden">
          <span
            className={cn(
              'inline-flex min-w-0 items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
              getStateTone(story.state.type)
            )}
          >
            <span className="truncate">{story.state.name}</span>
          </span>
          <span className="shrink-0 text-[11px] capitalize text-muted-foreground">
            {story.storyType}
          </span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {owner?.name ?? translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 max-lg:!hidden">
          {contextLabel ? (
            <span className="max-w-[160px] truncate text-[10px] text-muted-foreground xl:!hidden">
              {contextLabel}
            </span>
          ) : null}
          {labels.map((label) => (
            <span
              key={label}
              className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {story.labels.length > labels.length ? (
            <span className="text-[10px] text-muted-foreground">
              +{story.labels.length - labels.length}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 max-md:!hidden">
        <span
          className={cn(
            'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
            getStateTone(story.state.type)
          )}
        >
          <span className="truncate">{story.state.name}</span>
        </span>
      </div>

      <span className="block truncate text-[12px] capitalize text-muted-foreground max-md:!hidden">
        {story.storyType}
      </span>

      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground max-lg:!hidden">
        {owner?.avatarUrl ? (
          <img src={owner.avatarUrl} alt={owner.name} className="size-5 shrink-0 rounded-full" />
        ) : (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px]">
            {owner?.name?.slice(0, 1) ?? '-'}
          </span>
        )}
        <span className="truncate">
          {owner?.name ?? translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
        </span>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-md:!hidden">
            {formatUpdatedAt(story.updatedAt)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {new Date(story.updatedAt).toLocaleString()}
        </TooltipContent>
      </Tooltip>

      <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                onStartWorkspace(story)
              }}
              aria-label={translate(
                'auto.components.TaskPage.ff90d0abc7',
                'Start workspace from {{value0}}',
                { value0: reference }
              )}
            >
              <ArrowRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                window.api.shell.openUrl(story.url)
              }}
              aria-label={translate(
                'auto.components.TaskPage.openInShortcutItem',
                'Open {{value0}} in Shortcut',
                { value0: reference }
              )}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.TaskPage.openInShortcut', 'Open in Shortcut')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function TaskPageShortcutStoryList({
  formatUpdatedAt,
  getStateTone,
  stories,
  onOpenStory,
  onStartWorkspace,
  selectedStory,
  showWorkspaceContext,
  workflows
}: TaskPageShortcutStoryListProps): React.JSX.Element {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const sections = useMemo(
    () => groupShortcutStoriesByState(stories, workflows),
    [stories, workflows]
  )

  return (
    <div className="divide-y divide-border/50">
      {sections.map((section) => {
        const open = !collapsedGroups.has(section.key)
        return (
          <Collapsible
            key={section.key}
            open={open}
            onOpenChange={(nextOpen) => {
              setCollapsedGroups((current) => {
                const next = new Set(current)
                if (nextOpen) {
                  next.delete(section.key)
                } else {
                  next.add(section.key)
                }
                return next
              })
            }}
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-full justify-start rounded-none bg-muted/35 px-3 text-left font-normal transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {open ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {section.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {section.stories.length}
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="divide-y divide-border/50 border-t border-border/50">
              {section.stories.map((story) => (
                <ShortcutStoryRow
                  key={`${story.workspaceId ?? 'workspace'}:${story.id}`}
                  formatUpdatedAt={formatUpdatedAt}
                  getStateTone={getStateTone}
                  story={story}
                  onOpenStory={onOpenStory}
                  onStartWorkspace={onStartWorkspace}
                  selected={isSelectedStory(story, selectedStory)}
                  showWorkspaceContext={showWorkspaceContext}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
