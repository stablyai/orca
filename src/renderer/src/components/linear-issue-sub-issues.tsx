import React, { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowRight, LoaderCircle, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { linearCreateSubIssue } from '@/runtime/runtime-linear-issue-mutations'
import { useAppStore } from '@/store'
import type { LinearIssue, LinearIssueChildSummary } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

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
  const settings = useAppStore((state) => state.settings)
  const providerSettings = sourceContext ?? settings
  const fetchLinearIssue = useAppStore((state) => state.fetchLinearIssue)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [createdSubIssues, setCreatedSubIssues] = useState<LinearIssueChildSummary[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [openingSubIssueId, setOpeningSubIssueId] = useState<string | null>(null)
  const openRequestIdRef = useRef(0)
  const createRequestIdRef = useRef(0)
  const mountedRef = useMountedRef()
  const subIssues = useMemo(
    () => mergeLinearSubIssues(issue.subIssues, createdSubIssues),
    [createdSubIssues, issue.subIssues]
  )
  const handleOpenSubIssue = useCallback(
    async (subIssue: LinearIssueChildSummary) => {
      const requestId = ++openRequestIdRef.current
      setOpeningSubIssueId(subIssue.id)
      try {
        const fullIssue = await fetchLinearIssue(subIssue.id, issue.workspaceId, {
          sourceContext
        })
        if (!mountedRef.current || requestId !== openRequestIdRef.current) {
          return
        }
        if (fullIssue) {
          onOpenIssue(fullIssue)
        } else {
          toast.error(
            translate('auto.components.LinearIssueWorkspace.9a1317cdd3', 'Failed to load sub-issue')
          )
        }
      } catch (error) {
        if (mountedRef.current && requestId === openRequestIdRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.LinearIssueWorkspace.9a1317cdd3',
                  'Failed to load sub-issue'
                )
          )
        }
      } finally {
        if (mountedRef.current && requestId === openRequestIdRef.current) {
          setOpeningSubIssueId(null)
        }
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
          const child = {
            id: result.id,
            identifier: result.identifier,
            title: result.title || trimmed,
            url: result.url
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
          toast.error(result.error)
        }
      })
      .catch((error) => {
        if (mountedRef.current && requestId === createRequestIdRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
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
        <div className="mb-3 space-y-1">
          {subIssues.map((subIssue) => (
            <button
              key={subIssue.id}
              type="button"
              onClick={() => void handleOpenSubIssue(subIssue)}
              disabled={openingSubIssueId !== null}
              className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="shrink-0 font-mono text-xs">{subIssue.identifier}</span>
              <span className="min-w-0 flex-1 truncate">{subIssue.title}</span>
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
            <span>
              {translate('auto.components.LinearIssueWorkspace.8c55d6696a', 'Add sub-issues')}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <div className="space-y-3">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder={translate(
                'auto.components.LinearIssueWorkspace.c182e02de5',
                'Sub-issue title'
              )}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void handleCreate()}
                disabled={!title.trim() || submitting}
              >
                {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {translate('auto.components.LinearIssueWorkspace.42589845bc', 'Create')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </section>
  )
}
