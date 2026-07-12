import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'

export function useWorkspaceStartup() {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const createTab = useAppStore((s) => s.createTab)
  const queueTabStartupCommand = useAppStore((s) => s.queueTabStartupCommand)

  const initializedWorktrees = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    if (initializedWorktrees.current.has(activeWorktreeId)) {
      return
    }

    // find the active worktree to get its path
    let activeWorktree: { absolutePath?: string; path?: string } | null = null
    for (const repos of Object.values(worktreesByRepo)) {
      const found = repos.find((w) => w.id === activeWorktreeId)
      if (found) {
        activeWorktree = found
        break
      }
    }

    if (!activeWorktree) {
      return
    }

    // Mark as initialized so we don't repeat on re-renders or tab switches
    initializedWorktrees.current.add(activeWorktreeId)

    const worktreePath = activeWorktree.absolutePath || activeWorktree.path
    if (!worktreePath) {
      return
    }

    const configPath = `${worktreePath}/.orca-startup.json`

    window.api.fs
      .readFile(configPath, 'utf8')
      .then((content) => {
        try {
          const config = JSON.parse(content)
          if (Array.isArray(config.commands)) {
            for (const command of config.commands) {
              if (typeof command === 'string') {
                const tab = createTab(activeWorktreeId, undefined, undefined, {
                  quickCommandLabel: command
                })
                queueTabStartupCommand(tab.id, { command })
              }
            }
          }
        } catch (e) {
          console.error('Failed to parse .orca-startup.json', e)
        }
      })
      .catch(() => {
        // File does not exist or cannot be read; silently ignore
      })
  }, [activeWorktreeId, worktreesByRepo, createTab, queueTabStartupCommand])
}
