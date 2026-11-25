import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import { createWebRuntimeSessionTerminalOnHost } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { notifyWebRuntimeTerminalCreateFailure } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-failure-notice'
import { startStoppedWslHostForUserAct } from '@/runtime/hosts/wsl/wsl-host-user-start'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type NativeChatHostCommandTerminal = {
  opening: boolean
  open: (command: string, env?: Record<string, string>) => Promise<{ tabId?: string } | null>
  /** Brings an open terminal tab forward; false once it is gone. */
  show: (tabId: string) => boolean
}

/** Opens a visible terminal on the chat's own host running a setup command; null without a workspace. */
export function useNativeChatHostCommandTerminal(input: {
  target: RuntimeClientTarget
  worktreeId: string | null
  groupId?: string
}): NativeChatHostCommandTerminal | null {
  const { worktreeId, groupId } = input
  const environmentId = input.target.kind === 'environment' ? input.target.environmentId : null
  const [opening, setOpening] = useState(false)
  // Why a ref: a notice and a transcript row can both press, and state lags a double press.
  const openingRef = useRef(false)
  const open = useCallback(
    (command: string, env?: Record<string, string>) => {
      if (!worktreeId || openingRef.current) {
        return Promise.resolve(null)
      }
      openingRef.current = true
      setOpening(true)
      return (async () => {
        if (environmentId) {
          if (!(await startStoppedWslHostForUserAct(environmentId))) {
            return null
          }
          const outcome = await createWebRuntimeSessionTerminalOnHost(
            {
              worktreeId,
              environmentId,
              targetGroupId: groupId,
              command,
              ...(env && { env }),
              viewMode: 'terminal',
              activate: true
            },
            { notifyFailure: false }
          )
          if (outcome.status === 'failed') {
            notifyWebRuntimeTerminalCreateFailure(outcome.message, { environmentId, worktreeId })
            return null
          }
          return { tabId: outcome.mirroredTabId }
        }
        const store = useAppStore.getState()
        const tab = store.createTab(worktreeId, groupId, undefined, {
          pendingStartup: { command, ...(env && { env }) },
          viewMode: 'terminal'
        })
        store.setActiveTabType('terminal', worktreeId)
        persistAgentLaunchTabOrder(worktreeId, tab.id)
        return { tabId: tab.id }
      })()
        .catch(() => {
          toast.error(
            translate(
              'auto.store.slices.worktrees.localBaseRefUnshallowFailed',
              'Could not open a terminal for this workspace'
            )
          )
          return null
        })
        .finally(() => {
          openingRef.current = false
          setOpening(false)
        })
    },
    [worktreeId, groupId, environmentId]
  )
  const show = useCallback(
    (tabId: string) => {
      const store = useAppStore.getState()
      if (!worktreeId || !store.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
        return false
      }
      store.setActiveTabType('terminal', worktreeId)
      store.setActiveTab(tabId)
      focusTerminalTabSurface(tabId)
      return true
    },
    [worktreeId]
  )
  return useMemo(
    () => (worktreeId ? { opening, open, show } : null),
    [worktreeId, opening, open, show]
  )
}
