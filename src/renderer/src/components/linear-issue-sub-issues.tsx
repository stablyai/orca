import '@/store/slices/linear/linear-issue-read'
import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-read-lifecycle'
import {
  taskProviderErrorMessage,
  taskProviderErrorText
} from '@/lib/work-items/task-provider-error-copy'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, ArrowRight, LoaderCircle, Plus, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { getLinearStateMarkerStyle } from '@/components/linear-state-pill-style'
import {
  isLinearSubIssueOrderBy,
  loadLinearSubIssueViewOptions,
  orderLinearSubIssues,
  saveLinearSubIssueViewOptions,
  type LinearSubIssueOrderBy,
  type LinearSubIssueViewOptions
} from '@/components/linear-sub-issue-view-options'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { linearCreateSubIssue } from '@/runtime/linear/runtime-linear-issue-client'
import { useAppStore } from '@/store'
import type { LinearIssue, LinearIssueChildSummary } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'

function mergeLinearSubIssues(
  serverSubIssues: LinearIssueChildSummary[] | undefined,
  createdSubIssues: LinearIssueChildSummary[]
): LinearIssueChildSummary[] {
  const server = serverSubIssues ?? []
  if (createdSubIssues.length === 0) {
    return server
  }
  const serverIds = new Set(server.map((subIssue) => subIssue.id))
  return [...server, ...createdSubIssues.filter((subIssue) => !serverIds.has(subIssue.id))]
}

export function LinearIssueSubIssues({
  issue,
  onOpenIssue,
  sourceContext
}: {
  issue: LinearIssue
  onOpenIssue: (issue: LinearIssue) => void
  sourceContext?: TaskSourceContext | null
}): React.JSX.Element {
  const t = useTranslate()
  const settings = useAppStore((state) => state.settings)
  const providerSettings = sourceContext ?? defaultScopeSource(settings)
  const fetchLinearIssue = useAppStore((state) => state.fetchLinearIssue)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [createdSubIssues, setCreatedSubIssues] = useState<LinearIssueChildSummary[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [openingSubIssueId, setOpeningSubIssueId] = useState<string | null>(null)
  const openReadRef = useRef<(() => void) | null>(null)
  const openRequestIdRef = useRef(0)
  const createRequestIdRef = useRef(0)
  const mountedRef = useMountedRef()
  const subIssues = useMemo(
    () => mergeLinearSubIssues(issue.subIssues, createdSubIssues),
    [createdSubIssues, issue.subIssues]
  )
  const [viewOptions, setViewOptions] = useState(loadLinearSubIssueViewOptions)
  const updateViewOptions = useCallback((next: LinearSubIssueViewOptions) => {
    setViewOptions(next)
    saveLinearSubIssueViewOptions(next)
  }, [])
  const visibleSubIssues = useMemo(
    () => orderLinearSubIssues(subIssues, viewOptions),
    [subIssues, viewOptions]
  )
  const hiddenCompletedCount = subIssues.length - visibleSubIssues.length
  const orderOptions: { id: LinearSubIssueOrderBy; label: string }[] = [
    { id: 'manual', label: t('auto.components.linear.issue.sub.issues.653e08612f', 'Manual') },
    { id: 'status', label: t('auto.components.TaskPage.154b0fa623', 'Status') },
    { id: 'priority', label: t('auto.components.TaskPage.c8d5bec5f7', 'Priority') },
    { id: 'updated', label: t('auto.components.TaskPage.f362667d55', 'Updated') },
    { id: 'created', label: t('auto.components.linear.issue.sub.issues.cc9625649c', 'Created') }
  ]
  useEffect(() => {
    setOpeningSubIssueId(null)
    return () => {
      openReadRef.current?.()
      openRequestIdRef.current += 1
    }
  }, [issue.id, sourceContext])
  const handleOpenSubIssue = useCallback(
    (subIssue: LinearIssueChildSummary) => {
      openReadRef.current?.()
      const requestId = ++openRequestIdRef.current
      setOpeningSubIssueId(subIssue.id)
      let opened = false
      let release = () => {}
      release = observeLinearIssueRead(
        fetchLinearIssue(subIssue.id, issue.workspaceId, { sourceContext }),
        () => mountedRef.current && requestId === openRequestIdRef.current,
        (lease, view) => {
          if (opened || view.kind === 'loading') {
            return
          }
          if (view.kind === 'abandoned') {
            opened = true
            setOpeningSubIssueId((previous) =>
              mountedRef.current && requestId === openRequestIdRef.current ? null : previous
            )
            release()
            return
          }
          lease.commit(view, false, (_, fullIssue) => {
            opened = true
            setOpeningSubIssueId((previous) =>
              mountedRef.current && requestId === openRequestIdRef.current ? null : previous
            )
            if (fullIssue) {
              onOpenIssue(fullIssue)
            } else {
              toast.error(
                translate(
                  'auto.components.LinearIssueWorkspace.9a1317cdd3',
                  'Failed to load sub-issue'
                )
              )
            }
            release()
            return true
          })
        }
      )
      openReadRef.current = release
      if (opened) {
        release()
      }
    },
    [fetchLinearIssue, issue.workspaceId, mountedRef, onOpenIssue, sourceContext]
  )

  const handleCreate = useCallback(() => {
    const trimmed = title.trim()
    if (!trimmed) {
      return
    }
    const requestId = ++createRequestIdRef.current
    setSubmitting(true)
    void linearCreateSubIssue(providerSettings, {
      parentIssueId: issue.id,
      teamId: issue.team.id,
      title: trimmed,
      workspaceId: issue.workspaceId,
      projectId: issue.project?.id ?? null
    })
      .then((result) => {
        if (!mountedRef.current || requestId !== createRequestIdRef.current) {
          return
        }
        if (result.ok) {
          // Stamp local time so date orderings place it as newest until the server copy replaces it.
          const createdAt = new Date().toISOString()
          const child = {
            id: result.id,
            identifier: result.identifier,
            title: result.title || trimmed,
            url: result.url,
            createdAt,
            updatedAt: createdAt
          }
          setCreatedSubIssues((current) => {
            if (
              current.some((subIssue) => subIssue.id === child.id) ||
              issue.subIssues?.some((subIssue) => subIssue.id === child.id)
            ) {
              return current
            }
            return [...current, child]
          })
          toast.success(
            translate('auto.components.LinearIssueWorkspace.aeed19d003', 'Created {{value0}}', {
              value0: result.identifier
            })
          )
          setTitle('')
          setOpen(false)
        } else {
          toast.error(taskProviderErrorMessage(result))
        }
      })
      .catch((error) => {
        if (mountedRef.current && requestId === createRequestIdRef.current) {
          toast.error(
            error instanceof Error
              ? taskProviderErrorText(error.message)
              : translate(
                  'auto.components.LinearIssueWorkspace.b25e453c9d',
                  'Failed to create sub-issue'
                )
          )
        }
      })
      .finally(() => {
        if (mountedRef.current && requestId === createRequestIdRef.current) {
          setSubmitting(false)
        }
      })
  }, [issue, mountedRef, providerSettings, title])

  return (
    <section className="mt-10 max-w-[820px]">
      {subIssues.length > 0 ? (
        <div className="mb-2 flex items-center justify-between gap-3 pl-1.5">
          <h2 className="text-sm font-semibold text-foreground">
            {t('auto.components.linear.issue.sub.issues.f38946d078', 'Sub-issues')}
          </h2>
          <div className="flex min-w-0 items-center gap-2">
            {hiddenCompletedCount > 0 ? (
              <span className="truncate text-xs text-muted-foreground">
                {t(
                  'auto.components.linear.issue.sub.issues.4d2a139ffc',
                  '{{value0}} completed hidden',
                  {
                    value0: hiddenCompletedCount
                  }
                )}
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t(
                    'auto.components.linear.issue.sub.issues.1734f8fdd9',
                    'Sub-issue display options'
                  )}
                >
                  <SlidersHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <span className="flex items-center gap-2">
                    <ArrowDownUp className="size-3.5" />
                    {t('auto.components.TaskPage.5d2d835467', 'Ordering')}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={viewOptions.orderBy}
                  onValueChange={(value) => {
                    if (isLinearSubIssueOrderBy(value)) {
                      updateViewOptions({ ...viewOptions, orderBy: value })
                    }
                  }}
                >
                  {orderOptions.map((option) => (
                    <DropdownMenuRadioItem key={option.id} value={option.id}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={viewOptions.showCompleted}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    updateViewOptions({ ...viewOptions, showCompleted: checked === true })
                  }
                >
                  {t(
                    'auto.components.linear.issue.sub.issues.ba2b66f817',
                    'Show completed sub-issues'
                  )}
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ) : null}
      {visibleSubIssues.length > 0 ? (
        <div className="mb-3 space-y-1">
          {visibleSubIssues.map((subIssue) => (
            <button
              key={subIssue.id}
              type="button"
              onClick={() => void handleOpenSubIssue(subIssue)}
              disabled={openingSubIssueId !== null}
              className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="shrink-0 font-mono text-xs">{subIssue.identifier}</span>
              <span className="min-w-0 flex-1 truncate">{subIssue.title}</span>
              {subIssue.state?.name ? (
                <span className="flex max-w-[30%] shrink-0 items-center gap-1.5 text-xs">
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={getLinearStateMarkerStyle(subIssue.state.color)}
                  />
                  <span className="truncate">{subIssue.state.name}</span>
                </span>
              ) : null}
              {openingSubIssueId === subIssue.id ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <ArrowRight className="size-3.5 shrink-0" />
              )}
            </button>
          ))}
        </div>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-9 items-center gap-2 rounded-md px-1 text-sm font-medium text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Plus className="size-4" />
            <span>{t('auto.components.LinearIssueWorkspace.8c55d6696a', 'Add sub-issues')}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <div className="space-y-3">
            <ImeInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder={t('auto.components.LinearIssueWorkspace.c182e02de5', 'Sub-issue title')}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void handleCreate()}
                disabled={!title.trim() || submitting}
              >
                {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {t('auto.components.LinearIssueWorkspace.42589845bc', 'Create')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </section>
  )
}
