import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Play, Square, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { createIpcPtyTransport, type PtyTransport } from '@/components/terminal-pane/pty-transport'
import type { FsChangedPayload } from '../../../../shared/types'

type PackageScripts = Record<string, string>

type RunningScript = {
  id: number
  name: string
  command: string
  terminal: Terminal
  fitAddon: FitAddon
  transport: PtyTransport
  exited: boolean
  exitCode: number | null
}

let nextScriptId = 0

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
      const touchesPackageJson = payload.events.some((e) =>
        e.absolutePath.endsWith('package.json')
      )
      if (touchesPackageJson) {
        void fetchScripts()
      }
    })

    return unsubscribe
  }, [worktreePath, fetchScripts])

  return { scripts, loading }
}

export default function ScriptRunner(): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const [packageManager, setPackageManager] = useState<'pnpm' | 'yarn' | 'npm'>('npm')
  const [selectedScript, setSelectedScript] = useState<string | null>(null)
  const [editingCommand, setEditingCommand] = useState<string | null>(null)
  const [commandOverrides, setCommandOverrides] = useState<Record<string, string>>({})
  const [runningScripts, setRunningScripts] = useState<RunningScript[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const runningScriptsRef = useRef(runningScripts)
  runningScriptsRef.current = runningScripts

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

  const { scripts, loading } = usePackageScripts(worktreePath)

  useEffect(() => {
    if (!worktreePath) return
    void detectPackageManager(worktreePath).then(setPackageManager)
  }, [worktreePath])

  useEffect(() => {
    if (scripts && !selectedScript) {
      const first = Object.keys(scripts)[0]
      if (first) setSelectedScript(first)
    }
  }, [scripts, selectedScript])

  const activeScript = runningScripts.find((s) => s.id === activeTabId)

  // Mount active tab's terminal to the container
  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container || !activeScript) return

    container.innerHTML = ''
    activeScript.terminal.open(container)
    requestAnimationFrame(() => activeScript.fitAddon.fit())
  }, [activeScript])

  // Resize terminal when container resizes
  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container || !activeScript) return

    const observer = new ResizeObserver(() => {
      activeScript.fitAddon.fit()
      activeScript.transport.resize(activeScript.terminal.cols, activeScript.terminal.rows)
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [activeScript])

  // Cleanup all PTYs on unmount
  useEffect(() => {
    return () => {
      for (const script of runningScriptsRef.current) {
        script.transport.disconnect()
        script.terminal.dispose()
      }
    }
  }, [])

  const handleRun = useCallback(() => {
    if (!selectedScript || !worktreePath || !scripts) return

    const command =
      commandOverrides[selectedScript] ?? `${packageManager} run ${selectedScript}`

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 12,
      fontFamily:
        '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", monospace',
      fontWeight: '300',
      scrollback: 5000,
      macOptionIsMeta: true
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const transport = createIpcPtyTransport({ cwd: worktreePath })
    const scriptId = nextScriptId++

    const newScript: RunningScript = {
      id: scriptId,
      name: selectedScript,
      command,
      terminal,
      fitAddon,
      transport,
      exited: false,
      exitCode: null
    }

    setRunningScripts((prev) => [...prev, newScript])
    setActiveTabId(scriptId)

    requestAnimationFrame(() => {
      const container = terminalContainerRef.current
      if (container) {
        container.innerHTML = ''
        terminal.open(container)
        fitAddon.fit()
      }

      transport.connect({
        url: '',
        cols: terminal.cols,
        rows: terminal.rows,
        callbacks: {
          onData: (data) => terminal.write(data),
          onConnect: () => transport.sendInput(`${command}\r`),
          onExit: (code) => {
            setRunningScripts((prev) =>
              prev.map((s) =>
                s.id === scriptId ? { ...s, exited: true, exitCode: code } : s
              )
            )
          }
        }
      })

      terminal.onData((data) => transport.sendInput(data))
      terminal.onResize(({ cols, rows }) => transport.resize(cols, rows))
    })
  }, [selectedScript, worktreePath, scripts, packageManager, commandOverrides])

  const handleStop = useCallback((scriptId: number) => {
    setRunningScripts((prev) => {
      const script = prev.find((s) => s.id === scriptId)
      if (!script || script.exited) return prev
      script.transport.disconnect()
      return prev.map((s) =>
        s.id === scriptId ? { ...s, exited: true, exitCode: -1 } : s
      )
    })
  }, [])

  const handleCloseTab = useCallback(
    (scriptId: number) => {
      const script = runningScripts.find((s) => s.id === scriptId)
      if (!script) return
      if (!script.exited) script.transport.disconnect()
      script.terminal.dispose()

      setRunningScripts((prev) => {
        const next = prev.filter((s) => s.id !== scriptId)
        if (activeTabId === scriptId) {
          const closedIdx = prev.findIndex((s) => s.id === scriptId)
          const fallback = next[Math.min(closedIdx, next.length - 1)]
          setActiveTabId(fallback?.id ?? null)
        }
        return next
      })
    },
    [runningScripts, activeTabId]
  )

  if (!worktreePath || (!scripts && !loading)) return null

  const scriptNames = scripts ? Object.keys(scripts) : []
  const currentCommand =
    selectedScript && commandOverrides[selectedScript]
      ? commandOverrides[selectedScript]
      : selectedScript
        ? `${packageManager} run ${selectedScript}`
        : ''
  const isRunning = selectedScript
    ? runningScripts.some((s) => s.name === selectedScript && !s.exited)
    : false

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-sidebar-border">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full shrink-0 items-center gap-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
        <span>Scripts</span>
        {runningScripts.filter((s) => !s.exited).length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[10px] font-normal normal-case tracking-normal text-emerald-500">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {runningScripts.filter((s) => !s.exited).length}
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Script picker row */}
          <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1.5 rounded-md border border-border/50 bg-secondary/50 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary">
                  {isRunning && (
                    <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                  )}
                  <span className="max-w-[60px] truncate">
                    {selectedScript ?? 'Select'}
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" className="w-44">
                {scriptNames.map((name) => {
                  const running = runningScripts.some(
                    (s) => s.name === name && !s.exited
                  )
                  return (
                    <DropdownMenuItem
                      key={name}
                      onClick={() => setSelectedScript(name)}
                      className="gap-2 text-[11px]"
                    >
                      {running ? (
                        <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                      ) : (
                        <span className="size-1.5 shrink-0" />
                      )}
                      <span className="truncate">{name}</span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <input
              type="text"
              value={editingCommand ?? currentCommand}
              onChange={(e) => setEditingCommand(e.target.value)}
              onFocus={(e) => setEditingCommand(e.target.value)}
              onBlur={() => {
                if (editingCommand !== null && selectedScript) {
                  setCommandOverrides((prev) => ({
                    ...prev,
                    [selectedScript]: editingCommand
                  }))
                }
                setEditingCommand(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (editingCommand !== null && selectedScript) {
                    setCommandOverrides((prev) => ({
                      ...prev,
                      [selectedScript]: editingCommand
                    }))
                  }
                  setEditingCommand(null)
                  ;(e.target as HTMLInputElement).blur()
                } else if (e.key === 'Escape') {
                  setEditingCommand(null)
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              className="h-6 min-w-0 flex-1 rounded-md border border-border/50 bg-background/50 px-2 font-mono text-[10px] text-muted-foreground outline-none transition-colors focus:border-ring focus:text-foreground"
              spellCheck={false}
            />

            {isRunning ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 shrink-0 text-red-500 hover:text-red-400"
                    onClick={() => {
                      const script = runningScripts.find(
                        (s) => s.name === selectedScript && !s.exited
                      )
                      if (script) handleStop(script.id)
                    }}
                  >
                    <Square className="size-3 fill-current" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  Stop {selectedScript}
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 shrink-0 text-emerald-500 hover:text-emerald-400 disabled:opacity-30"
                    onClick={handleRun}
                    disabled={!selectedScript}
                  >
                    <Play className="size-3 fill-current" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  Run {currentCommand}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Tabs for running scripts */}
          {runningScripts.length > 0 && (
            <>
              <div className="flex shrink-0 overflow-x-auto border-t border-sidebar-border bg-background/30 scrollbar-none">
                {runningScripts.map((script) => (
                  <button
                    key={script.id}
                    onClick={() => setActiveTabId(script.id)}
                    className={`group flex shrink-0 items-center gap-1.5 border-r border-sidebar-border px-2.5 py-1 text-[11px] transition-colors ${
                      script.id === activeTabId
                        ? 'bg-background text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full shrink-0 ${
                        script.exited
                          ? script.exitCode === 0
                            ? 'bg-muted-foreground/40'
                            : 'bg-red-500'
                          : 'bg-emerald-500'
                      }`}
                    />
                    <span className="max-w-[50px] truncate">{script.name}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCloseTab(script.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation()
                          handleCloseTab(script.id)
                        }
                      }}
                      className="rounded-sm p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent"
                    >
                      <X className="size-2.5" />
                    </span>
                  </button>
                ))}
              </div>

              <div
                ref={terminalContainerRef}
                className="min-h-[120px] flex-1 overflow-hidden"
              />
            </>
          )}

          {runningScripts.length === 0 && (
            <div className="flex flex-1 items-center justify-center px-4 py-6">
              <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
                Select a script and press{' '}
                <kbd className="rounded border border-border/60 bg-secondary/50 px-1 py-0.5 text-[10px]">
                  Play
                </kbd>{' '}
                to run it here
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
