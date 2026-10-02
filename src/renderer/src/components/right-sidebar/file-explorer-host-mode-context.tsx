import React from 'react'
import { cn } from '@/lib/utils'
import { FileExplorerHostBar } from './FileExplorerHostBar'
import { FileExplorerHostList } from './FileExplorerHostList'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import {
  HostModeContext,
  useFileExplorerHostModeContext
} from './file-explorer-host-mode-context-value'
import { useFileExplorerHostMode } from './use-file-explorer-host-mode'

/**
 * Owns Host-mode state below FileExplorerFiles so toggling re-renders only its subscribers;
 * `children` are elements from the parent render, so the tree bails out untouched.
 */
export function FileExplorerHostModeProvider({
  activeWorktreeId,
  worktreePath,
  children
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  children: React.ReactNode
}): React.JSX.Element {
  const hostMode = useFileExplorerHostMode({ activeWorktreeId, worktreePath })
  return <HostModeContext.Provider value={hostMode}>{children}</HostModeContext.Provider>
}

export function FileExplorerHostAwareToolbar(
  props: Omit<React.ComponentProps<typeof FileExplorerToolbar>, 'hostMode'>
): React.JSX.Element {
  const hostMode = useFileExplorerHostModeContext()
  return (
    <FileExplorerToolbar
      {...props}
      canRefresh={props.canRefresh && !hostMode.active}
      canCollapseAll={props.canCollapseAll && !hostMode.active}
      hostMode={{
        active: hostMode.active,
        available: hostMode.available,
        onToggle: hostMode.active ? hostMode.exit : hostMode.enter
      }}
    />
  )
}

/** Hides Project-only chrome in Host mode without unmounting it. */
export function FileExplorerProjectOnly({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const { active } = useFileExplorerHostModeContext()
  return <div className={cn(active ? 'hidden' : 'contents')}>{children}</div>
}

/** Project UI covered by the Host overlay must not take focus or keystrokes (Tab, focus requests). */
export function FileExplorerHostInertBoundary({
  className = 'h-full min-h-0',
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const { active } = useFileExplorerHostModeContext()
  return (
    <div className={className} inert={active} aria-hidden={active || undefined}>
      {children}
    </div>
  )
}

/** Layered over the tree so entering Host mode never shifts the surrounding layout. */
export function FileExplorerHostOverlay({
  showDotfiles
}: {
  showDotfiles: boolean
}): React.JSX.Element | null {
  const hostMode = useFileExplorerHostModeContext()
  if (!hostMode.active) {
    return null
  }
  return (
    <div
      className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background"
      data-file-explorer-host-overlay=""
    >
      <div className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 duration-150 ease-out motion-reduce:animate-none">
        <FileExplorerHostBar hostMode={hostMode} />
        <FileExplorerHostList hostMode={hostMode} showDotfiles={showDotfiles} />
      </div>
    </div>
  )
}
