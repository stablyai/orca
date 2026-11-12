import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import React, { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CircleDot } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useRepoSlugIndex } from '@/lib/workspace/catalog/repo-slug-index'
import { runtimeTargetForRepoOwner } from '@/lib/workspace/ownership/repo-runtime-owner'
import { gitHubSlugApiForTarget } from '@/runtime/repository-github/github-slug-owner-api'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import type { GitHubIssueType, GitHubProjectRow } from '../../../../shared/github/project-types'
import { chipStyle, colorHex, singleSelectChipColors } from './project-cell-chip-colors'

export function ProjectIssueTypeCell({
  row,
  editable,
  sourceHost,
  sourceTarget,
  onEditIssueType
}: {
  row: GitHubProjectRow
  editable: boolean
  sourceHost?: string
  sourceTarget: RuntimeClientTarget
  onEditIssueType?: (issueType: GitHubIssueType | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const issueType = row.content.issueType
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<GitHubIssueType[]>([])
  const [loading, setLoading] = useState(false)
  const [owner, repo] = (row.content.repository ?? '').split('/')
  const { lookupSlug } = useRepoSlugIndex()
  const matchedRepo = useMemo(
    () => lookupSlug(row.content.repository, sourceHost)[0] ?? null,
    [lookupSlug, row.content.repository, sourceHost]
  )
  const ownerTarget = useAppStore(
    useShallow((state) => (matchedRepo ? runtimeTargetForRepoOwner(state, matchedRepo.id) : null))
  )

  useEffect(() => {
    if (!open || !owner || !repo) {
      return
    }
    let cancelled = false
    setLoading(true)
    const target = ownerTarget ?? sourceTarget
    const request = gitHubSlugApiForTarget(target).listIssueTypesBySlug({
      owner,
      repo,
      ...(sourceHost ? { host: sourceHost } : {})
    })
    void request
      .then((result) => {
        if (!cancelled && result.ok) {
          setOptions(result.types)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, owner, ownerTarget, repo, sourceHost, sourceTarget])

  const trigger = (
    <span className="inline-flex items-center gap-1 text-xs">
      <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
      {issueType ? (
        <span
          className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--github-project-chip-fg-light)] dark:text-[var(--github-project-chip-fg-dark)]"
          style={chipStyle(singleSelectChipColors(issueType.color ?? ''))}
        >
          {issueType.name}
        </span>
      ) : (
        <span className="text-muted-foreground">
          {t('auto.components.github.project.ProjectCell.c5f949e489', 'Issue')}
        </span>
      )}
    </span>
  )
  if (!editable) {
    return <div>{trigger}</div>
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('auto.components.github.project.ProjectCell.c7b059cf07', 'Issue type')}
          className="flex h-full w-full cursor-pointer items-center px-1 text-left"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {!owner || !repo ? (
          <ProjectIssueTypeMessage
            message={t(
              'auto.components.github.project.ProjectCell.54cac64427',
              'Row has no repo slug.'
            )}
          />
        ) : loading ? (
          <ProjectIssueTypeMessage
            message={t('auto.components.github.project.ProjectCell.2219e945ef', 'Loading…')}
          />
        ) : options.length === 0 ? (
          <ProjectIssueTypeMessage
            message={t(
              'auto.components.github.project.ProjectCell.943b3dadc9',
              'This repo has no Issue Types.'
            )}
          />
        ) : (
          options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/50"
              onClick={() => {
                onEditIssueType?.(option)
                setOpen(false)
              }}
            >
              <span
                className="mt-1 inline-block size-2 shrink-0 rounded-full"
                style={{ background: colorHex(option.color ?? '') || '#8b949e' }}
              />
              <span className="min-w-0">
                <span className="block truncate">{option.name}</span>
                {option.description ? (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          ))
        )}
        {issueType ? (
          <button
            type="button"
            className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50"
            onClick={() => {
              onEditIssueType?.(null)
              setOpen(false)
            }}
          >
            {t('auto.components.github.project.ProjectCell.ebde486e3c', 'Clear')}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function ProjectIssueTypeMessage({ message }: { message: string }): React.JSX.Element {
  return <div className="px-2 py-1 text-xs text-muted-foreground">{message}</div>
}
