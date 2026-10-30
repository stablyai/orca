import { useCallback, useMemo } from 'react'
import { Clipboard, ExternalLink, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult
} from '../../../shared/jira/jira-types'
import { applyJiraIssueKeyCasing } from '../../../shared/workspace-name'
import type { WorkspaceSeedNameOptions } from '../../../shared/workspace-name'
import { getJiraIssueKeyCasingSeedOptions } from '@/lib/jira-issue-key-casing'
import { buildJiraIssuePrompt } from './jira-prompt-templates'
import {
  issueCopiedMessage,
  issueCopyFailedMessage,
  type IssueCopyTarget
} from './issue-copy-target-messages'
import type { JiraIssueWorkspaceAction } from './jira-issue-workspace-content'
import { openAppHttpLink } from '@/lib/app-http-link-open'

export function useJiraIssueWorkspaceActions({
  displayed,
  titleDraft,
  labelsDraft,
  setTitleDraft,
  mutateIssue
}: {
  displayed: JiraIssue | null
  titleDraft: string
  labelsDraft: string
  setTitleDraft: (value: string) => void
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>
  ) => Promise<JiraMutationResult>
}) {
  const handleSaveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateIssue('title', { title }, { title })
  }, [displayed, mutateIssue, setTitleDraft, titleDraft])

  const handleSaveLabels = useCallback(() => {
    if (!displayed) {
      return
    }
    const labels = labelsDraft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void mutateIssue('labels', { labels }, { labels })
  }, [displayed, labelsDraft, mutateIssue])

  const actionItems = useMemo(
    () => (displayed ? getJiraIssueWorkspaceActions(displayed) : []),
    [displayed]
  )

  return { handleSaveTitle, handleSaveLabels, actionItems }
}

export function buildJiraBranchName(
  issue: Pick<JiraIssue, 'key' | 'title'>,
  options: WorkspaceSeedNameOptions = {}
): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  return applyJiraIssueKeyCasing(
    `${issue.key.toLowerCase()}${slug ? `-${slug}` : ''}`,
    issue.key,
    options.jiraIssueKeyCasing
  )
}

export async function copyJiraTextToClipboard(
  text: string,
  target: IssueCopyTarget
): Promise<boolean> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(issueCopiedMessage(target))
    return true
  } catch {
    toast.error(issueCopyFailedMessage(target))
    return false
  }
}

export function getJiraIssueWorkspaceActions(issue: JiraIssue): JiraIssueWorkspaceAction[] {
  return [
    {
      label: translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira'),
      icon: ExternalLink,
      action: () => openAppHttpLink(issue.url)
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.779bb91ee0', 'Copy URL'),
      icon: Clipboard,
      action: () => void copyJiraTextToClipboard(issue.url, 'url')
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.38839801e8', 'Copy key'),
      icon: Clipboard,
      action: () => void copyJiraTextToClipboard(issue.key, 'key')
    },
    {
      label: translate(
        'auto.components.JiraIssueWorkspace.80efa101c5',
        'Copy suggested branch name'
      ),
      icon: GitBranch,
      action: () =>
        void copyJiraTextToClipboard(
          buildJiraBranchName(issue, getJiraIssueKeyCasingSeedOptions()),
          'branchName'
        )
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.0cc62bd690', 'Copy prompt'),
      icon: Clipboard,
      action: () => void copyJiraTextToClipboard(buildJiraIssuePrompt(issue), 'prompt')
    }
  ]
}
