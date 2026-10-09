import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { PtyTransport } from './pty-transport'
import { captureTerminalDropTarget, getCurrentTerminalDropTransport } from './terminal-drop-target'
import { captureTerminalDropTransportOwner } from './terminal-drop-transport-owner'
import { resolveTerminalDropWorktreePath } from './terminal-drop-worktree-path'
import { isWorktreeUsingLocalWslRuntime } from './terminal-drop-local-wsl'
import { deliverNativeTerminalFileDrop } from './terminal-native-file-drop'

export type NativeTerminalFileDropArgs = {
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  worktreeId: string
  tabId: string
  cwd: string | undefined
  pane: { id: number; leafId: string }
  paths: string[]
}

/** Capture before preparation so asynchronous work cannot choose a replacement PTY. */
export function captureNativeTerminalFileDrop(
  args: Omit<NativeTerminalFileDropArgs, 'paths'>
): (paths: string[]) => Promise<void> {
  try {
    return captureNativeTerminalFileDropDestination(args)
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to drop files.'))
    return async () => undefined
  }
}

export async function handleNativeTerminalFileDrop(
  args: NativeTerminalFileDropArgs
): Promise<void> {
  await captureNativeTerminalFileDrop(args)(args.paths)
}

function captureNativeTerminalFileDropDestination(
  args: Omit<NativeTerminalFileDropArgs, 'paths'>
): (paths: string[]) => Promise<void> {
  const { manager, paneTransports, worktreeId, tabId, cwd, pane } = args
  const transport = paneTransports.get(pane.id)
  if (!transport) {
    return async () => undefined
  }
  const dropTarget = captureTerminalDropTarget(pane, transport)
  const state = useAppStore.getState()
  const settings = state.settings
  const owner = captureTerminalDropTransportOwner(transport)
  const worktreePath = resolveTerminalDropWorktreePath(
    worktreeId,
    owner?.runtimeEnvironmentId ? undefined : cwd,
    owner?.executionHostId,
    owner?.runtimeEnvironmentId
  )
  if (!worktreePath) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.ce8248b835',
        'Worktree path not available.'
      )
    )
    return async () => undefined
  }
  const localWslDrop = isWorktreeUsingLocalWslRuntime(state, worktreeId)
  return async (paths) => {
    if (!paths.length || !getCurrentTerminalDropTransport(manager, paneTransports, dropTarget)) {
      return
    }
    try {
      owner?.assertCurrent()
      await deliverNativeTerminalFileDrop({
        manager,
        paneTransports,
        worktreeId,
        tabId,
        pane,
        dataPaths: paths,
        dropTarget,
        settings,
        owner,
        worktreePath,
        localWslDrop
      })
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to drop files.'))
    }
  }
}
