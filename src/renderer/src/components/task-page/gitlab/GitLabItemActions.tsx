import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Clipboard,
  CircleCheck,
  CircleDot,
  EllipsisVertical,
  ExternalLink,
  LoaderCircle,
  Tag,
  Users
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { gitLabApiFor } from '@/runtime/repository-gitlab/gitlab-owner-api'
import { codeHostErrorText } from '@/lib/source-control/remote/code-host-error-copy'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { getTaskPageRepoSourceContext } from '@/lib/work-items/task-repo-source-context'
import {
  issueCopiedMessage,
  issueCopyFailedMessage
} from '../../clipboard/issue-copy-target-messages'
import type { GitLabWorkItem } from '../../../../../shared/gitlab/gitlab-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { parseGitLabIssueOrMRLink } from '../../../../../shared/new-workspace/gitlab-links'
import {
  GitLabItemPicker,
  type GitLabRowSelector,
  type PickerKind,
  type MutationResult
} from './GitLabItemPicker'

function itemSelector(repo: Repo | undefined, item: GitLabWorkItem): GitLabRowSelector | null {
  if (!repo || (item.repoHostId && item.repoHostId !== getRepoExecutionHostId(repo))) {
    return null
  }
  const parsed = parseGitLabIssueOrMRLink(item.url)
  const projectRef =
    item.projectRef ??
    (parsed?.type === item.type && parsed.number === item.number ? parsed.slug : null)
  if (!projectRef) {
    return null
  }
  const sourceContext = getTaskPageRepoSourceContext(repo, 'gitlab', projectRef)
  if (!sourceContext) {
    return null
  }
  return {
    projectRef,
    repoPath: repo.path,
    repoId: repo.id,
    repoOwnerExecutionHostId: getRepoExecutionHostId(repo),
    sourceContext
  }
}

export function GitLabItemActions({
  item,
  repo,
  onRefresh
}: {
  item: GitLabWorkItem
  repo: Repo | undefined
  onRefresh: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [picker, setPicker] = useState<PickerKind | null>(null)
  const [busy, setBusy] = useState(false)
  const selector = useMemo(() => (open ? itemSelector(repo, item) : null), [open, repo, item])
  const handleOpenChange = (next: boolean): void => {
    if (!busy) {
      setOpen(next)
      setPicker(null)
    }
  }
  const runMutation = async (mutate: () => Promise<MutationResult>): Promise<void> => {
    setBusy(true)
    try {
      const result = await mutate()
      if (!result.ok) {
        toast.error(codeHostErrorText(result))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setOpen(false)
      setPicker(null)
      // A failed or partial response doesn't prove the server kept the previous values.
      onRefresh()
    }
  }
  const changeState = (): void => {
    if (!selector) {
      return
    }
    const next = item.state === 'closed' ? 'opened' : 'closed'
    void runMutation(() => {
      const api = gitLabApiFor(selector)
      if (item.type === 'issue') {
        return api.updateIssue({ ...selector, number: item.number, updates: { state: next } })
      }
      return next === 'closed'
        ? api.closeMR({ ...selector, iid: item.number })
        : api.reopenMR({ ...selector, iid: item.number })
    })
  }
  const copyUrl = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(item.url)
      toast.success(issueCopiedMessage('url'))
    } catch {
      toast.error(issueCopyFailedMessage('url'))
    }
    handleOpenChange(false)
  }
  const pickerTitle =
    picker === 'labels'
      ? t('auto.components.TaskPage.d0ca4aa1d0', 'Labels')
      : picker === 'assignees'
        ? t('auto.components.TaskPage.8aba10579d', 'Assignees')
        : t('auto.components.TaskPage.f6fa3c97d0', 'Reviewers')
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('auto.components.TaskPage.66ae7330f6', 'More actions')}
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
        >
          <EllipsisVertical className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 max-w-[calc(100vw-16px)]"
        onClick={(event) => event.stopPropagation()}
      >
        {picker && selector ? (
          <>
            <div className="flex items-center gap-2 border-b px-2 py-1.5 text-xs font-medium">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                onClick={() => setPicker(null)}
                aria-label={t('auto.components.TaskPage.f397d513e3', 'Back')}
              >
                <ArrowLeft className="size-3.5" />
              </Button>
              {pickerTitle}
            </div>
            <GitLabItemPicker
              selector={selector}
              item={item}
              kind={picker}
              busy={busy}
              runMutation={runMutation}
            />
          </>
        ) : (
          <div className="flex flex-col gap-0.5 p-1">
            <div className="flex min-w-0 items-center gap-2 border-b px-2 py-1.5 text-xs text-muted-foreground">
              <span className="shrink-0 font-mono">
                {item.type === 'mr' ? '!' : '#'}
                {item.number}
              </span>
              <span className="truncate" title={item.title}>
                {item.title}
              </span>
            </div>
            {selector ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  disabled={busy}
                  onClick={() => setPicker('labels')}
                >
                  <Tag className="size-3.5" />
                  {t('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  disabled={busy}
                  onClick={() => setPicker(item.type === 'issue' ? 'assignees' : 'reviewers')}
                >
                  <Users className="size-3.5" />
                  {item.type === 'issue'
                    ? t('auto.components.TaskPage.8aba10579d', 'Assignees')
                    : t('auto.components.TaskPage.f6fa3c97d0', 'Reviewers')}
                </Button>
                {item.state === 'opened' || item.state === 'closed' || item.state === 'draft' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-start"
                    disabled={busy}
                    onClick={changeState}
                  >
                    {busy ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : item.state === 'closed' ? (
                      <CircleDot className="size-3.5" />
                    ) : (
                      <CircleCheck className="size-3.5" />
                    )}
                    {item.state === 'closed'
                      ? t('auto.components.GitLabItemDialog.65e784c1f1', 'Reopen')
                      : t('auto.components.GitLabItemDialog.a199eb364b', 'Close')}
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={busy}
              onClick={() => void copyUrl()}
            >
              <Clipboard className="size-3.5" />
              {t('auto.components.JiraIssueWorkspace.779bb91ee0', 'Copy URL')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={busy}
              onClick={(event) => {
                openAppHttpLink(item.url, { event })
                handleOpenChange(false)
              }}
            >
              <ExternalLink className="size-3.5" />
              {t('auto.components.TaskPage.bcdc1330b2', 'Open in GitLab')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
