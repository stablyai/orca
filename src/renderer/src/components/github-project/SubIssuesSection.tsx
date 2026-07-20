// Why: Phase 2 — issue-level hierarchy navigation + writes for the
// work-item drawer's "Sub-issues" section. Distinct from Phase 1b's flat
// table columns (ProjectCell.tsx) — this fetches on-demand when the drawer
// opens (see project-view/hierarchy.ts), not as part of the paginated table
// fetch. See docs/reference/2026-07-15-github-projects-hierarchy-phase2-plan.md.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, LoaderCircle, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { computeHierarchyRollup } from '../../../../shared/github-issue-hierarchy-rollup'
import type {
  GetIssueHierarchyResult,
  GitHubIssueHierarchyNode
} from '../../../../shared/github-project-types'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type Props = {
  owner: string
  repo: string
  number: number
  editable: boolean
  sourceSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

type HierarchyState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: Extract<GetIssueHierarchyResult, { ok: true }> }

async function fetchHierarchy(
  args: { owner: string; repo: string; number: number },
  sourceSettings: Props['sourceSettings']
): Promise<GetIssueHierarchyResult> {
  const target = getActiveRuntimeTarget(sourceSettings)
  return target.kind === 'environment'
    ? callRuntimeRpc<GetIssueHierarchyResult>(target, 'github.project.getIssueHierarchy', args, {
        timeoutMs: 30_000
      })
    : window.api.gh.getIssueHierarchy(args)
}

// Why: same shape mutation entry points (add/remove/reprioritize) share this
// SSH-aware dispatch — extracted so each call site is a one-line call.
function mutateGitHub<T>(
  method:
    | 'github.project.addSubIssue'
    | 'github.project.removeSubIssue'
    | 'github.project.reprioritizeSubIssue',
  localCall: () => Promise<T>,
  args: unknown,
  sourceSettings: Props['sourceSettings']
): Promise<T> {
  const target = getActiveRuntimeTarget(sourceSettings)
  return target.kind === 'environment'
    ? callRuntimeRpc<T>(target, method, args, { timeoutMs: 30_000 })
    : localCall()
}

export default function SubIssuesSection({
  owner,
  repo,
  number,
  editable,
  sourceSettings
}: Props): React.JSX.Element | null {
  const [state, setState] = useState<HierarchyState>({ status: 'loading' })
  const [addValue, setAddValue] = useState('')
  const [pendingAction, setPendingAction] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const load = useCallback(() => {
    requestIdRef.current += 1
    const rid = requestIdRef.current
    setState({ status: 'loading' })
    fetchHierarchy({ owner, repo, number }, sourceSettings)
      .then((res) => {
        if (rid !== requestIdRef.current) {
          return
        }
        setState(
          res.ok ? { status: 'ready', data: res } : { status: 'error', message: res.error.message }
        )
      })
      .catch((err) => {
        if (rid !== requestIdRef.current) {
          return
        }
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load sub-issues.'
        })
      })
  }, [owner, repo, number, sourceSettings])

  useEffect(() => {
    load()
  }, [load])

  const openIssue = useCallback((url: string) => {
    void window.api.shell.openUrl(url)
  }, [])

  const handleAdd = useCallback(() => {
    const parsed = Number.parseInt(addValue, 10)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return
    }
    setPendingAction(parsed)
    setActionError(null)
    mutateGitHub(
      'github.project.addSubIssue',
      () => window.api.gh.addSubIssue({ owner, repo, number, subIssueNumber: parsed }),
      { owner, repo, number, subIssueNumber: parsed },
      sourceSettings
    )
      .then((res) => {
        if (res.ok) {
          setAddValue('')
          load()
        } else {
          setActionError(res.error.message)
        }
      })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Failed to add sub-issue.')
      })
      .finally(() => setPendingAction(null))
  }, [addValue, owner, repo, number, sourceSettings, load])

  const handleRemove = useCallback(
    (subIssueNumber: number) => {
      setPendingAction(subIssueNumber)
      setActionError(null)
      mutateGitHub(
        'github.project.removeSubIssue',
        () => window.api.gh.removeSubIssue({ owner, repo, number, subIssueNumber }),
        { owner, repo, number, subIssueNumber },
        sourceSettings
      )
        .then((res) => {
          if (res.ok) {
            load()
          } else {
            setActionError(res.error.message)
          }
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : 'Failed to remove sub-issue.')
        })
        .finally(() => setPendingAction(null))
    },
    [owner, repo, number, sourceSettings, load]
  )

  const handleReprioritize = useCallback(
    (subIssueNumber: number, direction: 'up' | 'down', siblings: GitHubIssueHierarchyNode[]) => {
      const idx = siblings.findIndex((s) => s.number === subIssueNumber)
      if (idx === -1) {
        return
      }
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1
      const targetSibling = siblings[targetIdx]
      if (!targetSibling) {
        return
      }
      const args =
        direction === 'up'
          ? { owner, repo, number, subIssueNumber, beforeNumber: targetSibling.number }
          : { owner, repo, number, subIssueNumber, afterNumber: targetSibling.number }
      setPendingAction(subIssueNumber)
      setActionError(null)
      mutateGitHub(
        'github.project.reprioritizeSubIssue',
        () => window.api.gh.reprioritizeSubIssue(args),
        args,
        sourceSettings
      )
        .then((res) => {
          if (res.ok) {
            load()
          } else {
            setActionError(res.error.message)
          }
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : 'Failed to reorder sub-issue.')
        })
        .finally(() => setPendingAction(null))
    },
    [owner, repo, number, sourceSettings, load]
  )

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        {translate(
          'auto.components.github.project.SubIssuesSection.loading',
          'Loading sub-issues…'
        )}
      </div>
    )
  }

  if (state.status === 'error') {
    return <div className="px-1 py-2 text-xs text-destructive">{state.message}</div>
  }

  const { parent, subIssues } = state.data
  const rollup = computeHierarchyRollup({
    state: 'OPEN',
    subIssuesSummary: state.data.subIssuesSummary,
    subIssues
  })

  if (!parent && subIssues.length === 0 && !editable) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 px-1 py-2 text-xs">
      {parent ? (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span>
            {translate('auto.components.github.project.SubIssuesSection.parent', 'Parent:')}
          </span>
          <a
            href={parent.url}
            title={parent.title}
            onClick={(e) => {
              e.preventDefault()
              openIssue(parent.url)
            }}
            className="text-foreground hover:underline"
          >
            #{parent.number}
          </a>
        </div>
      ) : null}

      {subIssues.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Progress value={rollup.percentCompleted} className="h-1.5 w-16 shrink-0" />
            <span className="text-muted-foreground">
              {rollup.completedDescendants}/{rollup.totalDescendants}
            </span>
          </div>
          {subIssues.map((child, idx) => (
            <div key={child.number} className="flex items-center gap-1.5">
              <a
                href={child.url}
                title={child.title}
                onClick={(e) => {
                  e.preventDefault()
                  openIssue(child.url)
                }}
                className="truncate text-foreground hover:underline"
              >
                #{child.number}
              </a>
              <span className="truncate text-muted-foreground">{child.title}</span>
              {editable ? (
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    disabled={pendingAction === child.number || idx === 0}
                    aria-label={translate(
                      'auto.components.github.project.SubIssuesSection.moveUp',
                      'Move #{{value0}} up',
                      { value0: String(child.number) }
                    )}
                    onClick={() => handleReprioritize(child.number, 'up', subIssues)}
                  >
                    <ArrowUp className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    disabled={pendingAction === child.number || idx === subIssues.length - 1}
                    aria-label={translate(
                      'auto.components.github.project.SubIssuesSection.moveDown',
                      'Move #{{value0}} down',
                      { value0: String(child.number) }
                    )}
                    onClick={() => handleReprioritize(child.number, 'down', subIssues)}
                  >
                    <ArrowDown className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    disabled={pendingAction === child.number}
                    aria-label={translate(
                      'auto.components.github.project.SubIssuesSection.remove',
                      'Remove #{{value0}}',
                      { value0: String(child.number) }
                    )}
                    onClick={() => handleRemove(child.number)}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {actionError ? <div className="text-destructive">{actionError}</div> : null}

      {editable ? (
        <div className="flex items-center gap-1.5">
          <Input
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder={translate(
              'auto.components.github.project.SubIssuesSection.addPlaceholder',
              'Issue number'
            )}
            className="h-6 w-24 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 text-xs"
            disabled={addValue.trim().length === 0}
            onClick={handleAdd}
          >
            <Plus className="size-3" />
            {translate('auto.components.github.project.SubIssuesSection.add', 'Add sub-issue')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
