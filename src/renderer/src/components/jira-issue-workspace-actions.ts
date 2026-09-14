import { Clipboard, ExternalLink, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../shared/jira-types'
import type { JiraIssueWorkspaceAction } from './jira-issue-workspace-content'

function buildJiraBranchName(issue: JiraIssue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  return `${issue.key.toLowerCase()}${slug ? `-${slug}` : ''}`
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.JiraIssueWorkspace.2ff69a3545', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.JiraIssueWorkspace.6c41a9bcea', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
    )
  }
}

export function getJiraIssueWorkspaceActions(issue: JiraIssue): JiraIssueWorkspaceAction[] {
  return [
    {
      label: translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira'),
      icon: ExternalLink,
      action: () => window.api.shell.openUrl(issue.url)
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.779bb91ee0', 'Copy URL'),
      icon: Clipboard,
      action: () => void copyTextToClipboard(issue.url, 'URL')
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.38839801e8', 'Copy key'),
      icon: Clipboard,
      action: () => void copyTextToClipboard(issue.key, 'Key')
    },
    {
      label: translate(
        'auto.components.JiraIssueWorkspace.80efa101c5',
        'Copy suggested branch name'
      ),
      icon: GitBranch,
      action: () => void copyTextToClipboard(buildJiraBranchName(issue), 'Branch name')
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.0cc62bd690', 'Copy prompt'),
      icon: Clipboard,
      action: () =>
        void copyTextToClipboard(
          `Complete Jira issue ${issue.key}: ${issue.title}\n\n${issue.url}`,
          'Prompt'
        )
    }
  ]
}
