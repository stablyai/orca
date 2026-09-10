import { Network } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export default function MaestroNavigatorSidebarEntry(): React.JSX.Element {
  const open = useAppStore((state) => state.maestroNavigatorOpen)
  const setOpen = useAppStore((state) => state.setMaestroNavigatorOpen)
  const setDashboardOpen = useAppStore((state) => state.setAgentDashboardDrawerOpen)

  return (
    <button
      type="button"
      onClick={() => {
        setDashboardOpen(false)
        setOpen(!open)
      }}
      aria-expanded={open}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        open
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Network
        className={cn('size-4 shrink-0', !open && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={open ? 2.25 : 1.75}
      />
      <span className="flex-1">
        {translate('auto.components.maestro.navigator.title', 'Maestro')}
      </span>
    </button>
  )
}
