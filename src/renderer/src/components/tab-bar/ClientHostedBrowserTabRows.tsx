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

/** Append paired-client pages outside persisted tab ordering so they cannot acquire drag/pin/group ownership. */
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
              // Report refused closes visibly because this host has no other handle on the remote page.
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
