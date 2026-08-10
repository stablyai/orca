import type React from 'react'
import { Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert } from 'lucide-react'
import { GITHUB_ALERT_TYPES, type GithubAlertType } from './markdown-github-alerts'

const ALERT_ICONS: Record<GithubAlertType, React.ComponentType<{ className?: string }>> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: TriangleAlert,
  caution: OctagonAlert
}

export const GITHUB_ALERT_TITLES: Record<GithubAlertType, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution'
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
