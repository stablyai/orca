import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { paneClaudeTarget } from './terminal-pane-claude-target'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

const RESIZE_RECHECK_MS = 300

function useClaudeDiffPanelMayAutoOpen(
  ptyId: string,
  tabId: string,
  container: HTMLElement,
  wanted: boolean
): boolean {
  const [mayAutoOpen, setMayAutoOpen] = useState(false)
  useEffect(() => {
    const target = wanted ? paneClaudeTarget(tabId) : null
    if (!target) {
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let latestRequest = 0
    const ask = (): void => {
      // Why the sequence: answers can land out of order, and only the newest describes the pane.
      const request = (latestRequest += 1)
      void window.api.pty
        .claudeDiffPanelMayAutoOpen(ptyId, target)
        .catch(() => false)
        .then((answer) => {
          if (!cancelled && request === latestRequest) {
            setMayAutoOpen(answer)
          }
        })
    }
    ask()
    // Why re-ask on resize: main judges the panel's width gate from the pane's current columns.
    let initialNotification = true
    const observer = new ResizeObserver(() => {
      if (initialNotification) {
        initialNotification = false
        return
      }
      clearTimeout(timer)
      timer = setTimeout(ask, RESIZE_RECHECK_MS)
    })
    observer.observe(container)
    return () => {
      cancelled = true
      clearTimeout(timer)
      observer.disconnect()
      setMayAutoOpen(false)
    }
  }, [wanted, ptyId, tabId, container])
  return mayAutoOpen
}

/** Tells the user once that the diff panel Claude Code opens in a wide pane is Claude's own, and
 *  how to hide it. Shown only while Claude's saved config still lets the panel open unasked. */
export function ClaudeDiffPanelNoticeBanner({
  ptyId,
  tabId,
  leafId,
  container
}: {
  ptyId: string
  tabId: string
  leafId: string
  /** The pane element, watched for width changes. */
  container: HTMLElement
}): React.JSX.Element | null {
  const paneKey = makePaneKey(tabId, leafId)
  const seen = useAppStore((state) => state.claudeDiffPanelNoticeSeen)
  const markSeen = useAppStore((state) => state.markClaudeDiffPanelNoticeSeen)
  // Why either signal: a typed claude is seen by the process read, or by its hooks.
  const claudeInPane = useAppStore(
    (state) =>
      state.paneForegroundAgentByPaneKey[paneKey]?.agent === 'claude' ||
      state.agentStatusByPaneKey[paneKey]?.agentType === 'claude'
  )
  const mayAutoOpen = useClaudeDiffPanelMayAutoOpen(ptyId, tabId, container, claudeInPane && !seen)
  if (seen || !mayAutoOpen) {
    return null
  }
  return (
    <PaneTopWarningBanner
      title={translate(
        'terminal.claudeDiffPanelNotice.title',
        "Claude Code can open its own diff panel beside the chat in wide terminals. That panel is Claude's, not Orca's."
      )}
      body={translate(
        'terminal.claudeDiffPanelNotice.body',
        'To hide it, type /diff in Claude Code. Claude remembers that choice for later sessions.'
      )}
      primaryAction={
        <Button type="button" variant="outline" size="xs" onClick={markSeen}>
          {translate('terminal.claudeDiffPanelNotice.gotIt', 'Got it')}
        </Button>
      }
    />
  )
}
