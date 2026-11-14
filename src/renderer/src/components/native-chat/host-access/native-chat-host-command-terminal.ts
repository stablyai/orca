import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import { createWebRuntimeSessionTerminalOnHost } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { notifyWebRuntimeTerminalCreateFailure } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-failure-notice'
import { startStoppedWslHostForUserAct } from '@/runtime/hosts/wsl/wsl-host-user-start'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

export type NativeChatHostCommandTerminal = {
  opening: boolean
  open: (command: string) => Promise<boolean>
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
    (command: string) => {
      if (!worktreeId || openingRef.current) {
        return Promise.resolve(false)
      }
      openingRef.current = true
      setOpening(true)
      return (async () => {
        if (environmentId) {
          if (!(await startStoppedWslHostForUserAct(environmentId))) {
            return false
          }
          const outcome = await createWebRuntimeSessionTerminalOnHost(
            {
              worktreeId,
              environmentId,
              targetGroupId: groupId,
              command,
              viewMode: 'terminal',
              activate: true
            },
            { notifyFailure: false }
          )
          if (outcome.status === 'failed') {
            notifyWebRuntimeTerminalCreateFailure(outcome.message, { environmentId, worktreeId })
            return false
          }
        } else {
          const store = useAppStore.getState()
          const tab = store.createTab(worktreeId, groupId, undefined, {
            pendingStartup: { command },
            viewMode: 'terminal'
          })
          store.setActiveTabType('terminal', worktreeId)
          persistAgentLaunchTabOrder(worktreeId, tab.id)
        }
        return true
      })()
        .catch(() => {
          toast.error(
            translate(
              'auto.store.slices.worktrees.localBaseRefUnshallowFailed',
              'Could not open a terminal for this workspace'
            )
          )
          return false
        })
        .finally(() => {
          openingRef.current = false
          setOpening(false)
        })
    },
    [worktreeId, groupId, environmentId]
  )
  return useMemo(() => (worktreeId ? { opening, open } : null), [worktreeId, opening, open])
}
