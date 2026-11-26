import type { ReactNode } from 'react'
import { cn } from '@/lib/class-names'
import WslMovedProjectsSection from '../wsl-move/WslMovedProjectsSection'
import HiddenProjectsSection from './hidden-projects/HiddenProjectsSection'

export function SidebarProjectWorkspaces({
  collapsed,
  children
}: {
  collapsed: boolean
  children: ReactNode
}) {
  return (
    <>
      <div
        data-sidebar-project-workspaces=""
        className={cn('flex min-h-0 shrink flex-col', collapsed && 'hidden')}
      >
        {children}
      </div>
      {collapsed ? null : <WslMovedProjectsSection />}
      {collapsed ? null : <HiddenProjectsSection />}
    </>
  )
}
