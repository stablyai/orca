import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import {
  selectClientHostedBrowserRow,
  useActiveClientHostedBrowserRowId
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import { closeClientHostedBrowserRow } from '../../runtime/client-hosted-browser-row-close'
import ClientHostedBrowserTab from './ClientHostedBrowserTab'

/**
 * Trailing rows for pages hosted on a paired client, rendered after the strip's real tabs.
 *
 * They sit outside `orderedItems` on purpose: that list drives dnd-kit ordering, pinning, and the
 * group's `tabOrder`, none of which these rows may join — group ownership for a page this host
 * does not render is an unsettled product question, and joining would put them in the persisted
 * session. Appending here gives them a place in the strip without any of that.
 */
export default function ClientHostedBrowserTabRows({
  rows,
  worktreeId,
  groupId,
  groupActiveTabId,
  includeTopTabBorder
}: {
  rows: readonly ClientHostedBrowserRow[]
  worktreeId: string
  groupId: string
  groupActiveTabId: string | null
  includeTopTabBorder: boolean
}): React.JSX.Element | null {
  const activeRowId = useActiveClientHostedBrowserRowId({ worktreeId, groupId, groupActiveTabId })
  const focusGroup = useAppStore((state) => state.focusGroup)

  const activate = useCallback(
    (browserPageId: string) => {
      focusGroup(worktreeId, groupId)
      selectClientHostedBrowserRow({
        worktreeId,
        browserPageId,
        groupId,
        groupActiveTabIdAtSelection: groupActiveTabId
      })
    },
    [focusGroup, groupActiveTabId, groupId, worktreeId]
  )

  if (rows.length === 0) {
    return null
  }

  return (
    <>
      {rows.map((row, index) => (
        <ClientHostedBrowserTab
          key={row.browserPageId}
          row={row}
          isActive={activeRowId === row.browserPageId}
          hasTabsToRight={index < rows.length - 1}
          includeTopTabBorder={includeTopTabBorder}
          onActivate={() => activate(row.browserPageId)}
          onClose={() => {
            void closeClientHostedBrowserRow({
              worktreeId,
              browserPageId: row.browserPageId
            }).catch((error: unknown) => {
              // Why a toast: this row is the only handle on a page the host does not render, so a
              // refusal that only reaches the console leaves it sitting there as a missed click.
              toast.error(
                translate(
                  'browser.clientHosted.hostRowCloseFailed',
                  "Couldn't close this page. The device hosting it may be busy — try again."
                )
              )
              console.error('Failed to close client-hosted browser page:', error)
            })
          }}
        />
      ))}
    </>
  )
}
