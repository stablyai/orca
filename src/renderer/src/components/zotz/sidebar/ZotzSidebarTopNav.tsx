import React from 'react'
import { Home, Plus, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { openWorkspaceCreationComposerWithTourHandoff } from '../../contextual-tours/workspace-creation-tour-handoff'

function NavButton({
  icon: Icon,
  label,
  shortcut,
  active,
  onClick
}: {
  icon: LucideIcon
  label: string
  shortcut?: 'workspace.create' | 'worktree.palette'
  active?: boolean
  onClick: () => void
}): React.JSX.Element {
  const combos = useShortcutKeyComboDetails(shortcut ?? 'worktree.palette')
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/70 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">{label}</span>
      {shortcut ? (
        <span className="pointer-events-none flex shrink-0 items-center gap-1">
          {combos.slice(0, 1).map((combo) => (
            <ShortcutKeyCombo
              key={combo.keys.join('-')}
              keys={combo.keys}
              doubleTap={combo.doubleTap}
              className="inline-flex gap-0.5"
              keyCapClassName="min-w-4 border-worktree-sidebar-border/80 bg-worktree-sidebar-foreground/8 px-1 py-px text-3xs text-worktree-sidebar-foreground/55 shadow-none"
            />
          ))}
        </span>
      ) : null}
    </button>
  )
}

/** Home, Create and Search: the whole top of the simple sidebar. */
export default function ZotzSidebarTopNav(): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const atHome = useAppStore((s) => s.activeView === 'terminal' && s.activeWorktreeId === null)

  const goHome = (): void => {
    setActiveView('terminal')
    setActiveWorktree(null)
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-2 pb-1">
      <NavButton
        icon={Home}
        label={t('zotz.sidebar.home', 'Home')}
        active={atHome}
        onClick={goHome}
      />
      <NavButton
        icon={Plus}
        label={t('zotz.sidebar.create', 'Create')}
        shortcut="workspace.create"
        onClick={openWorkspaceCreationComposerWithTourHandoff}
      />
      <NavButton
        icon={Search}
        label={t('auto.components.sidebar.SidebarNav.80611a8b10', 'Search')}
        shortcut="worktree.palette"
        onClick={() => openModal('worktree-palette')}
      />
    </div>
  )
}
