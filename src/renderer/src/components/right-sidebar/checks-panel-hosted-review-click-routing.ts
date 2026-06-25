import { openHttpLink, type OpenHttpLinkOptions } from '@/lib/http-link-routing'

type ChecksPanelHostedReviewClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export function isChecksPanelHostedReviewSystemBrowserModifier(
  event: ChecksPanelHostedReviewClickEvent,
  isMac: boolean
): boolean {
  return event.shiftKey && (isMac ? event.metaKey : event.ctrlKey)
}

export function resolveChecksPanelHostedReviewHttpOpenOptions(
  event: ChecksPanelHostedReviewClickEvent,
  isMac: boolean,
  worktreeId: string | null | undefined
): OpenHttpLinkOptions {
  if (isChecksPanelHostedReviewSystemBrowserModifier(event, isMac)) {
    return { worktreeId, forceSystemBrowser: true }
  }
  return { worktreeId }
}

export function openChecksPanelHostedReviewUrl({
  url,
  event,
  isMac,
  worktreeId
}: {
  url: string
  event: ChecksPanelHostedReviewClickEvent
  isMac: boolean
  worktreeId: string | null | undefined
}): void {
  openHttpLink(url, resolveChecksPanelHostedReviewHttpOpenOptions(event, isMac, worktreeId))
}
