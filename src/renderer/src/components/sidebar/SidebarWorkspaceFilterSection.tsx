import React, { useCallback, useMemo } from 'react'
import { Activity, GitBranch } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'

const SidebarWorkspaceFilterSection = React.memo(function SidebarWorkspaceFilterSection() {
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)

  const selectedRepoCount = useMemo(() => {
    let count = 0
    for (const repo of repos) {
      if (filterRepoIds.includes(repo.id)) {
        count += 1
      }
    }
    return count
  }, [repos, filterRepoIds])

  const hasAnyFilter = showActiveOnly || hideDefaultBranchWorkspace || selectedRepoCount > 0

  const clearAll = useCallback(() => {
    setShowActiveOnly(false)
    setHideDefaultBranchWorkspace(false)
    setFilterRepoIds([])
  }, [setShowActiveOnly, setHideDefaultBranchWorkspace, setFilterRepoIds])

  return (
    <>
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-semibold text-muted-foreground">Filters</span>
        {hasAnyFilter && (
          <button
            type="button"
            onClick={clearAll}
            className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Reset
          </button>
        )}
      </div>
      <FilterToggleRow
        icon={<Activity className="size-3.5" />}
        label="Active only"
        checked={showActiveOnly}
        onChange={setShowActiveOnly}
      />
      <FilterToggleRow
        icon={<GitBranch className="size-3.5" />}
        label="Hide default branch"
        checked={hideDefaultBranchWorkspace}
        onChange={setHideDefaultBranchWorkspace}
      />
    </>
  )
})

function FilterToggleRow({
  icon,
  label,
  checked,
  onChange
}: {
  icon: React.ReactNode
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-[12px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="inline-flex items-center gap-2 text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </span>
      <span
        aria-hidden
        className={cn(
          'relative h-3.5 w-6 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-2.5 rounded-full bg-background shadow-sm transition-transform',
            checked && 'translate-x-2.5'
          )}
        />
      </span>
    </button>
  )
}

export default SidebarWorkspaceFilterSection
