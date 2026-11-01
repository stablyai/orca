import { getConnectionId } from '@/lib/connection-context'
import { getLinkSourceLocalOpenOwner } from '@/lib/link-source-local-open-owner'
import { isRevealOrEditorOpenBlocked, type LocalPathOpenOwner } from '@/lib/local-path-open-guard'
import { revealInFileManager } from '@/lib/reveal-in-file-manager'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { mapTerminalFilePath, terminalLinkWslDistro } from './terminal-file-open-routing'
import { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'
import { resolvePaneWslDistro } from './terminal-pane-wsl-distro'
import type { PtyTransport } from './pty-transport-types'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'
import type { TerminalContextMenuFilePath } from './terminal-context-menu-file-link-resolver'

export function buildTerminalPaneContextMenuReveal(args: {
  contextMenuFilePathRef: React.RefObject<TerminalContextMenuFilePath | null>
  fallbackCwd: string
  open: boolean
  paneCwdRef: React.RefObject<PaneCwdMap>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  resolveMenuPane: () => ManagedPane | null
  worktreeId: string
}): {
  menuPane: ManagedPane | null
  onRevealInFileManager: () => Promise<void>
  revealInFileManagerBlocked: boolean
} {
  const menuPane = args.open ? args.resolveMenuPane() : null
  const menuTransport = menuPane ? args.paneTransportsRef.current.get(menuPane.id) : undefined
  const menuSourceOwner = resolveTerminalHttpLinkSourceOwner(menuTransport)
  const menuRevealOwner = menuPane
    ? getLinkSourceLocalOpenOwner(useAppStore.getState(), menuSourceOwner, args.worktreeId)
    : ('unresolved' as const)
  const revealInFileManagerBlocked = !menuPane || isRevealOrEditorOpenBlocked(menuRevealOwner)
  const onRevealInFileManager = async (): Promise<void> => {
    if (!menuPane) {
      return
    }
    const state = useAppStore.getState()
    const worktreePath =
      state.allWorktrees().find((candidate) => candidate.id === args.worktreeId)?.path ??
      args.fallbackCwd
    const runtimeEnvironmentId =
      menuSourceOwner.kind === 'runtime' ? menuSourceOwner.runtimeEnvironmentId : null
    const wslDistro = getConnectionId(args.worktreeId)
      ? null
      : resolvePaneWslDistro(state, args.worktreeId, worktreePath)
    await revealTerminalPaneContextPath({
      capturedFilePath: args.contextMenuFilePathRef.current,
      fallbackCwd: args.fallbackCwd,
      paneCwdMap: args.paneCwdRef.current,
      paneId: menuPane.id,
      ptyId: menuTransport?.getPtyId() ?? null,
      revealBlocked: revealInFileManagerBlocked,
      revealOwner: menuRevealOwner,
      runtimeEnvironmentId,
      worktreePath,
      wslDistro
    })
  }
  return { menuPane, onRevealInFileManager, revealInFileManagerBlocked }
}

export async function revealTerminalPaneContextPath(args: {
  capturedFilePath: TerminalContextMenuFilePath | null
  fallbackCwd: string
  paneCwdMap: PaneCwdMap
  paneId: number
  ptyId: string | null
  revealBlocked: boolean
  revealOwner: LocalPathOpenOwner
  runtimeEnvironmentId: string | null
  worktreePath: string
  wslDistro: string | null
}): Promise<void> {
  if (args.revealBlocked) {
    return
  }
  const path = args.capturedFilePath
    ? await args.capturedFilePath()
    : await resolveSplitCwd({
        paneCwdMap: args.paneCwdMap,
        sourcePaneId: args.paneId,
        sourcePtyId: args.ptyId,
        fallbackCwd: args.fallbackCwd
      })
  const mappedPath = mapTerminalFilePath(
    path,
    args.worktreePath,
    terminalLinkWslDistro(args.wslDistro, args.runtimeEnvironmentId)
  )
  await revealInFileManager(mappedPath, args.revealOwner)
}
