import React, { createContext, useContext, useMemo } from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { useWorkspaceShortcutModifier } from './use-workspace-shortcut-modifier'

const WorkspaceShortcutHintContext = createContext<ReadonlyMap<string, number> | null>(null)

export function WorkspaceShortcutHints({
  workspaceIdentities,
  children
}: {
  workspaceIdentities: readonly string[]
  children: React.ReactNode
}): React.JSX.Element {
  const keybindings = useAppStore((state) => state.keybindings)
  const activeModal = useAppStore((state) => state.activeModal)
  const activeView = useAppStore((state) => state.activeView)
  const held = useWorkspaceShortcutModifier(keybindings)
  const numbers = useMemo(
    () => new Map(workspaceIdentities.slice(0, 9).map((identity, index) => [identity, index + 1])),
    [workspaceIdentities]
  )
  return (
    <WorkspaceShortcutHintContext.Provider
      value={held && activeModal === 'none' && activeView === 'terminal' ? numbers : null}
    >
      {children}
    </WorkspaceShortcutHintContext.Provider>
  )
}

export function WorkspaceShortcutHint({
  worktree
}: {
  worktree: Worktree
}): React.JSX.Element | null {
  const numbers = useContext(WorkspaceShortcutHintContext)
  const number = numbers?.get(getWorktreeHostIdentity(worktree))
  return number === undefined ? null : (
    <span aria-hidden="true" className="pointer-events-none shrink-0" data-workspace-shortcut-hint>
      <ShortcutKeyCombo keys={[String(number)]} />
    </span>
  )
}
