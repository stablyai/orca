import React, { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Play, RotateCcw } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import type { FsChangedPayload } from '../../../../shared/types'

type PackageScripts = Record<string, string>

async function detectPackageManager(worktreePath: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  const pnpmExists = await window.api.shell.pathExists(`${worktreePath}/pnpm-lock.yaml`)
  if (pnpmExists) return 'pnpm'
  const yarnExists = await window.api.shell.pathExists(`${worktreePath}/yarn.lock`)
  if (yarnExists) return 'yarn'
  return 'npm'
}

function usePackageScripts(worktreePath: string | null): {
  scripts: PackageScripts | null
  loading: boolean
  refresh: () => void
} {
  const [scripts, setScripts] = useState<PackageScripts | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchScripts = useCallback(async () => {
    if (!worktreePath) {
      setScripts(null)
      return
    }
    setLoading(true)
    try {
      const { content } = await window.api.fs.readFile({
        filePath: `${worktreePath}/package.json`
      })
      const pkg = JSON.parse(content)
      setScripts(pkg.scripts ?? null)
    } catch {
      setScripts(null)
    } finally {
      setLoading(false)
    }
  }, [worktreePath])

  useEffect(() => {
    void fetchScripts()
  }, [fetchScripts])

  useEffect(() => {
    if (!worktreePath) return

    const unsubscribe = window.api.fs.onFsChanged((payload: FsChangedPayload) => {
      if (payload.worktreePath !== worktreePath) return
      const touchesPackageJson = payload.events.some((e) => e.absolutePath.endsWith('package.json'))
      if (touchesPackageJson) {
        void fetchScripts()
      }
    })

    return unsubscribe
  }, [worktreePath, fetchScripts])

  return { scripts, loading, refresh: fetchScripts }
}

function runScript(scriptName: string, packageManager: string): void {
  const state = useAppStore.getState()
  const activeWorktreeId = state.activeWorktreeId
  if (!activeWorktreeId) return

  const newTab = state.createTab(activeWorktreeId)
  state.queueTabStartupCommand(newTab.id, {
    command: `${packageManager} run ${scriptName}`
  })
  state.setActiveTab(newTab.id)
  state.setActiveTabType('terminal')
}

export default function ScriptRunner(): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const [packageManager, setPackageManager] = useState<'pnpm' | 'yarn' | 'npm'>('npm')

  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)

  const worktreePath = React.useMemo(() => {
    if (!activeWorktreeId) return null
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) return wt.path
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  const { scripts, loading, refresh } = usePackageScripts(worktreePath)

  useEffect(() => {
    if (!worktreePath) return
    void detectPackageManager(worktreePath).then(setPackageManager)
  }, [worktreePath])

  if (!worktreePath || (!scripts && !loading)) return null

  const scriptEntries = scripts ? Object.entries(scripts) : []

  return (
    <div className="shrink-0 border-t border-sidebar-border">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <div className="flex items-center gap-1">
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <span>Scripts</span>
          {scriptEntries.length > 0 && (
            <span className="text-[10px] font-normal tabular-nums">({scriptEntries.length})</span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                void refresh()
              }}
            >
              <RotateCcw className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Refresh scripts
          </TooltipContent>
        </Tooltip>
      </button>

      {!collapsed && (
        <div className="max-h-48 overflow-y-auto px-1 pb-1.5 scrollbar-sleek">
          {loading ? (
            <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              Loading scripts…
            </div>
          ) : scriptEntries.length === 0 ? (
            <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              No scripts in package.json
            </div>
          ) : (
            scriptEntries.map(([name, command]) => (
              <div
                key={name}
                className="group flex items-center justify-between rounded-sm px-2 py-1 hover:bg-accent/50 transition-colors"
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="truncate text-[12px] text-foreground/80 cursor-default">
                      {name}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8} className="max-w-72">
                    <code className="text-[11px]">{command}</code>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-5 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                      onClick={() => runScript(name, packageManager)}
                    >
                      <Play className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    Run {packageManager} run {name}
                  </TooltipContent>
                </Tooltip>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
