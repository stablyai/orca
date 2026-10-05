import { Clipboard, ExternalLink, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'

export type MantisBTIssueWorkspaceAction = {
  label: string
  icon: typeof ExternalLink
  action: () => void
}

function buildMantisBTBranchName(issue: MantisBTIssue): string {
  const slug = issue.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  return `mantisbt-${issue.id}${slug ? `-${slug}` : ''}`
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.MantisBTIssueWorkspace.copied', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.MantisBTIssueWorkspace.copyFailed', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
    )
  }
}

export function getMantisBTIssueWorkspaceActions(
  issue: MantisBTIssue
): MantisBTIssueWorkspaceAction[] {
  return [
    {
      label: translate('auto.components.MantisBTIssueWorkspace.openInMantisBT', 'Open in MantisBT'),
      icon: ExternalLink,
      action: () => window.api.shell.openUrl(issue.url)
    },
    {
      label: translate('auto.components.MantisBTIssueWorkspace.copyUrl', 'Copy URL'),
      icon: Clipboard,
      action: () => void copyTextToClipboard(issue.url, 'URL')
    },
    {
      label: translate('auto.components.MantisBTIssueWorkspace.copyId', 'Copy id'),
      icon: Clipboard,
      action: () => void copyTextToClipboard(issue.id, 'Id')
    },
    {
      label: translate(
        'auto.components.MantisBTIssueWorkspace.copyBranchName',
        'Copy suggested branch name'
      ),
      icon: GitBranch,
      action: () => void copyTextToClipboard(buildMantisBTBranchName(issue), 'Branch name')
    },
    {
      label: translate('auto.components.MantisBTIssueWorkspace.copyPrompt', 'Copy prompt'),
      icon: Clipboard,
      action: () =>
        void copyTextToClipboard(
          `Complete MantisBT issue #${issue.id}: ${issue.summary}\n\n${issue.url}`,
          'Prompt'
        )
    }
  ]
}
