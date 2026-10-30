import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  clearGitHubLinkCopied,
  createGitHubLinkCopyState,
  markGitHubLinkCopied,
  resolveGitHubLinkCopyState
} from '@/components/github-link-copy-state'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

export function useGitHubItemDialogLinkCopy(workItem: GitHubWorkItem | null): {
  linkCopied: boolean
  setLinkCopyButtonRef: (node: HTMLButtonElement | null) => void
  handleCopyWorkItemLink: () => Promise<void>
} {
  const workItemId = workItem?.id
  const [linkCopyState, setLinkCopyState] = useState(() => createGitHubLinkCopyState(workItemId))
  const resolvedLinkCopyState = resolveGitHubLinkCopyState(linkCopyState, workItemId)
  if (resolvedLinkCopyState !== linkCopyState) {
    // Why: switching items must not paint a stale "copied" indicator from the previous item.
    setLinkCopyState(resolvedLinkCopyState)
  }
  const linkCopied = resolvedLinkCopyState.copied
  // Ignore clipboard results after detach so they cannot start stale feedback timers.
  const linkCopyMountedRef = useRef(false)
  const linkCopiedResetTimerRef = useRef<number | null>(null)
  const clearLinkCopiedResetTimer = useCallback((): void => {
    if (linkCopiedResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(linkCopiedResetTimerRef.current)
    linkCopiedResetTimerRef.current = null
  }, [])
  const setLinkCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      linkCopyMountedRef.current = node !== null
      if (node === null) {
        // Own the feedback timer at the control’s lifetime; cancel on detach.
        clearLinkCopiedResetTimer()
      }
    },
    [clearLinkCopiedResetTimer]
  )

  const handleCopyWorkItemLink = useCallback(async (): Promise<void> => {
    if (!workItem) {
      return
    }
    try {
      // Electron IPC works when nested overlays lack browser clipboard focus/activation.
      await window.api.ui.writeClipboardText(workItem.url)
      if (!linkCopyMountedRef.current) {
        return
      }
      clearLinkCopiedResetTimer()
      const copiedWorkItemId = workItem.id
      setLinkCopyState(markGitHubLinkCopied(copiedWorkItemId))
      linkCopiedResetTimerRef.current = window.setTimeout(() => {
        linkCopiedResetTimerRef.current = null
        setLinkCopyState((current) => clearGitHubLinkCopied(current, copiedWorkItemId))
      }, 1500)
      toast.success(translate('auto.components.GitHubItemDialog.2e77dc2053', 'GitHub link copied'))
    } catch {
      toast.error(
        translate('auto.components.GitHubItemDialog.5fea151559', 'Failed to copy GitHub link')
      )
    }
  }, [clearLinkCopiedResetTimer, workItem])

  return { linkCopied, setLinkCopyButtonRef, handleCopyWorkItemLink }
}
