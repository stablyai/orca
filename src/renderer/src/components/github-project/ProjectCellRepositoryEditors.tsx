import React, { useMemo, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useRepoAssigneesBySlug, useRepoLabelsBySlug } from '@/hooks/useGitHubSlugMetadata'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { EmptyProjectCell, ProjectLabelChip, ProjectUserChip } from './ProjectCellValueEditors'

type RepositoryEditorProps = {
  row: GitHubProjectRow
  editable: boolean
  sourceHost?: string
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

export function ProjectAssigneesCell({
  row,
  editable,
  sourceHost,
  sourceSettings,
  onEditAssignees
}: RepositoryEditorProps & {
  onEditAssignees?: (add: string[], remove: string[]) => void
}): React.JSX.Element {
  const assignees = row.content.assignees
  const [open, setOpen] = useState(false)
  const [owner, repo] = (row.content.repository ?? '').split('/')
  const seedKey = useMemo(
    () =>
      assignees
        .map((assignee) => assignee.login)
        .sort()
        .join(','),
    [assignees]
  )
  const metadata = useRepoAssigneesBySlug(
    open ? owner : null,
    open ? repo : null,
    seedKey ? seedKey.split(',') : [],
    sourceSettings,
    sourceHost
  )
  const content =
    assignees.length === 0
      ? null
      : assignees.map((user) => <ProjectUserChip key={user.login} user={user} />)
  if (!editable) {
    return (
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {content}
      </div>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={translate(
            'auto.components.github.project.ProjectCell.f7cdb78efb',
            'Assignees'
          )}
          className="flex h-full w-full cursor-pointer flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {content ?? (
            <EmptyProjectCell
              label={translate('auto.components.github.project.ProjectCell.36341ffc66', 'Assign')}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <RepositoryEditorState owner={owner} repo={repo} loading={metadata.loading} />
        {owner && repo && !metadata.loading
          ? metadata.data.map((user) => {
              const selected = assignees.some((assignee) => assignee.login === user.login)
              return (
                <button
                  key={user.login}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                  onClick={() =>
                    selected
                      ? onEditAssignees?.([], [user.login])
                      : onEditAssignees?.([user.login], [])
                  }
                >
                  <SelectionDot selected={selected} />
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="size-4 rounded-full" />
                  ) : null}
                  {user.login}
                </button>
              )
            })
          : null}
      </PopoverContent>
    </Popover>
  )
}

export function ProjectLabelsCell({
  row,
  editable,
  sourceHost,
  sourceSettings,
  onEditLabels
}: RepositoryEditorProps & {
  onEditLabels?: (add: string[], remove: string[]) => void
}): React.JSX.Element {
  const labels = row.content.labels
  const [open, setOpen] = useState(false)
  const [owner, repo] = (row.content.repository ?? '').split('/')
  const metadata = useRepoLabelsBySlug(
    open ? owner : null,
    open ? repo : null,
    sourceSettings,
    sourceHost
  )
  const content =
    labels.length === 0
      ? null
      : labels.map((label) => <ProjectLabelChip key={label.name} label={label} />)
  if (!editable) {
    return <div className="flex flex-wrap items-center gap-1">{content}</div>
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={translate('auto.components.github.project.ProjectCell.8ae56a88a6', 'Labels')}
          className="flex h-full w-full cursor-pointer flex-wrap items-center gap-1 px-1"
        >
          {content ?? (
            <EmptyProjectCell
              label={translate(
                'auto.components.github.project.ProjectCell.2e26a06c70',
                'Add label'
              )}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <RepositoryEditorState owner={owner} repo={repo} loading={metadata.loading} />
        {owner && repo && !metadata.loading && metadata.data.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.github.project.ProjectCell.4b5b871da8',
              'No labels in this repo.'
            )}
          </div>
        ) : null}
        {owner && repo && !metadata.loading
          ? metadata.data.map((name) => {
              const selected = labels.some((label) => label.name === name)
              return (
                <button
                  key={name}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50"
                  onClick={() =>
                    selected ? onEditLabels?.([], [name]) : onEditLabels?.([name], [])
                  }
                >
                  <SelectionDot selected={selected} />
                  {name}
                </button>
              )
            })
          : null}
      </PopoverContent>
    </Popover>
  )
}

function RepositoryEditorState({
  owner,
  repo,
  loading
}: {
  owner?: string
  repo?: string
  loading: boolean
}): React.JSX.Element | null {
  if (!owner || !repo) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">
        {translate(
          'auto.components.github.project.ProjectCell.54cac64427',
          'Row has no repo slug.'
        )}
      </div>
    )
  }
  return loading ? (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      {translate('auto.components.github.project.ProjectCell.2219e945ef', 'Loading…')}
    </div>
  ) : null
}

function SelectionDot({ selected }: { selected: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-block size-2 rounded-full',
        selected ? 'bg-primary' : 'bg-muted-foreground/40'
      )}
    />
  )
}
