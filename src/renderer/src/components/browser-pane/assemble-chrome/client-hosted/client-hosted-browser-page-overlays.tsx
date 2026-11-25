import type { RefObject } from 'react'
import {
  BrowserPageFeedbackBadge,
  type BrowserPageFeedbackBadgeHandle
} from '../feedback/browser-page-feedback-badge'
import { BrowserLinkStatusBubble } from '../feedback/browser-link-status-bubble'
import BrowserFind from '../find/BrowserFind'
import { BrowserPasswordFillDropdown } from '../../passwords/BrowserPasswordFillDropdown'

/** What the desktop draws over a This-device page: zoom badge, saved logins, find bar, link status. */
export function ClientHostedBrowserPageOverlays({
  browserPageId,
  isActive,
  containerRef,
  webviewRef,
  feedbackBadgeRef,
  findOpen,
  onCloseFind,
  guestGeneration
}: {
  browserPageId: string
  isActive: boolean
  containerRef: RefObject<HTMLDivElement | null>
  webviewRef: RefObject<Electron.WebviewTag | null>
  feedbackBadgeRef: RefObject<BrowserPageFeedbackBadgeHandle | null>
  findOpen: boolean
  onCloseFind: () => void
  guestGeneration: number | null
}): React.JSX.Element {
  return (
    <>
      <BrowserPageFeedbackBadge ref={feedbackBadgeRef} />
      <BrowserPasswordFillDropdown
        isActive={isActive}
        browserPageId={browserPageId}
        containerRef={containerRef}
        webviewRef={webviewRef}
      />
      <BrowserFind
        browserPageId={browserPageId}
        isOpen={findOpen}
        onClose={onCloseFind}
        webviewRef={webviewRef}
        guestGeneration={guestGeneration}
      />
      <BrowserLinkStatusBubble browserPageId={browserPageId} />
    </>
  )
}
