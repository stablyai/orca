import type React from 'react'
import { Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { GITHUB_ALERT_TYPES, type GithubAlertType } from './markdown-github-alerts'

const ALERT_ICONS: Record<GithubAlertType, React.ComponentType<{ className?: string }>> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: TriangleAlert,
  caution: OctagonAlert
}

export function getGithubAlertTitle(type: GithubAlertType): string {
  switch (type) {
    case 'note':
      return translate('auto.components.editor.MarkdownGithubAlert.8b6fda49fa', 'Note')
    case 'tip':
      return translate('auto.components.editor.MarkdownGithubAlert.b28ab35be4', 'Tip')
    case 'important':
      return translate('auto.components.editor.MarkdownGithubAlert.eb04b1d571', 'Important')
    case 'warning':
      return translate('auto.components.editor.MarkdownGithubAlert.013315d1fa', 'Warning')
    case 'caution':
      return translate('auto.components.editor.MarkdownGithubAlert.91dd428e07', 'Caution')
  }
}

// Reads the alert type off the blockquote className the remark plugin attached.
export function getGithubAlertType(className: unknown): GithubAlertType | null {
  if (typeof className !== 'string') {
    return null
  }
  return GITHUB_ALERT_TYPES.find((type) => className.includes(`markdown-alert-${type}`)) ?? null
}

export function GithubAlertIcon({ type }: { type: GithubAlertType }): React.JSX.Element {
  const Icon = ALERT_ICONS[type]
  return <Icon className="markdown-alert-icon" />
}
