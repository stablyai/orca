import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Play, Square, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { createIpcPtyTransport, type PtyTransport } from '@/components/terminal-pane/pty-transport'
import type { FsChangedPayload } from '../../../../shared/types'

type PackageScripts = Record<string, string>

type RunningScript = {
  name: string
  command: string
  terminal: Terminal
  fitAddon: FitAddon
  transport: PtyTransport
  exited: boolean
  exitCode: number | null
}

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
      const touchesPackageJson = payload.events.some((e) => e.absolutePath.endsWith('package.json'))
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
  const [activeTabIndex, setActiveTabIndex] = useState(0)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

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

  // Auto-select first script
  useEffect(() => {
    if (scripts && !selectedScript) {
      const first = Object.keys(scripts)[0]
      if (first) setSelectedScript(first)
    }
  }, [scripts, selectedScript])

  // Mount active tab's terminal to the container
  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container) return
    const activeScript = runningScripts[activeTabIndex]
    if (!activeScript) return

    // Clear container and attach this terminal
    container.innerHTML = ''
    activeScript.terminal.open(container)
    requestAnimationFrame(() => {
      activeScript.fitAddon.fit()
    })
  }, [activeTabIndex, runningScripts])

  // Resize terminal when container resizes
  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container) return

    resizeObserverRef.current = new ResizeObserver(() => {
      const activeScript = runningScripts[activeTabIndex]
      if (activeScript) {
        activeScript.fitAddon.fit()
        activeScript.transport.resize(
          activeScript.terminal.cols,
          activeScript.terminal.rows
        )
      }
    })
    resizeObserverRef.current.observe(container)

    return () => {
      resizeObserverRef.current?.disconnect()
    }
  }, [activeTabIndex, runningScripts])

  // Cleanup all PTYs on unmount
  useEffect(() => {
    return () => {
      for (const script of runningScripts) {
        script.transport.disconnect()
        script.terminal.dispose()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional cleanup-only
  }, [])

  const handleRun = useCallback(() => {
    if (!selectedScript || !worktreePath || !scripts) return

    const command = commandOverrides[selectedScript] ?? `${packageManager} run ${selectedScript}`

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

    const newScript: RunningScript = {
      name: selectedScript,
      command,
      terminal,
      fitAddon,
      transport,
      exited: false,
      exitCode: null
    }

    setRunningScripts((prev) => [...prev, newScript])
    setActiveTabIndex((prev) => prev === 0 && runningScripts.length === 0 ? 0 : runningScripts.length)

    // Wait a tick for the terminal container to render, then connect
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
          onConnect: () => {
            // Send the command once PTY is ready
            transport.sendInput(`${command}\r`)
          },
          onExit: (code) => {
            setRunningScripts((prev) =>
              prev.map((s) =>
                s === newScript ? { ...s, exited: true, exitCode: code } : s
              )
            )
          }
        }
      })

      terminal.onData((data) => transport.sendInput(data))
      terminal.onResize(({ cols, rows }) => transport.resize(cols, rows))
    })
  }, [selectedScript, worktreePath, scripts, packageManager, commandOverrides, runningScripts.length])

  const handleStop = useCallback(
    (index: number) => {
      const script = runningScripts[index]
      if (!script) return
      script.transport.disconnect()
      setRunningScripts((prev) =>
        prev.map((s, i) => (i === index ? { ...s, exited: true, exitCode: -1 } : s))
      )
    },
    [runningScripts]
  )

  const handleCloseTab = useCallback(
    (index: number) => {
      const script = runningScripts[index]
      if (!script) return
      if (!script.exited) {
        script.transport.disconnect()
      }
      script.terminal.dispose()
      setRunningScripts((prev) => prev.filter((_, i) => i !== index))
      setActiveTabIndex((prev) => {
        if (prev >= index && prev > 0) return prev - 1
        return prev
      })
    },
    [runningScripts]
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
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full shrink-0 items-center gap-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        <span>Scripts</span>
      </button>

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Single-row script picker */}
          <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
            {/* Script dropdown */}
            <div className="relative">
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-foreground bg-secondary/70 hover:bg-secondary transition-colors"
              >
                {isRunning && (
                  <span className="size-2 rounded-full bg-green-500 shrink-0" />
                )}
                <span className="truncate max-w-[60px]">{selectedScript ?? '...'}</span>
                <ChevronDown className="size-3 text-muted-foreground shrink-0" />
              </button>

              {dropdownOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-popover py-1 shadow-lg">
                  {scriptNames.map((name) => {
                    const running = runningScripts.some((s) => s.name === name && !s.exited)
                    return (
                      <button
                        key={name}
                        onClick={() => {
                          setSelectedScript(name)
                          setDropdownOpen(false)
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-foreground/80 hover:bg-accent transition-colors"
                      >
                        {running && <span className="size-2 rounded-full bg-green-500 shrink-0" />}
                        <span className="truncate">{name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Editable command field */}
            <input
              type="text"
              value={editingCommand ?? currentCommand}
              onChange={(e) => setEditingCommand(e.target.value)}
              onBlur={() => {
                if (editingCommand !== null && selectedScript) {
                  setCommandOverrides((prev) => ({ ...prev, [selectedScript]: editingCommand }))
                }
                setEditingCommand(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (editingCommand !== null && selectedScript) {
                    setCommandOverrides((prev) => ({ ...prev, [selectedScript]: editingCommand }))
                  }
                  setEditingCommand(null)
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              className="h-6 min-w-0 flex-1 rounded border border-border/50 bg-background/50 px-2 text-[10px] font-mono text-muted-foreground outline-none focus:border-ring focus:text-foreground"
            />

            {/* Play / Stop button */}
            {isRunning ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 shrink-0 text-red-500 hover:text-red-400"
                    onClick={() => {
                      const idx = runningScripts.findIndex(
                        (s) => s.name === selectedScript && !s.exited
                      )
                      if (idx !== -1) handleStop(idx)
                    }}
                  >
                    <Square className="size-3" />
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
                    className="size-6 shrink-0 text-green-500 hover:text-green-400"
                    onClick={handleRun}
                    disabled={!selectedScript}
                  >
                    <Play className="size-3" />
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
              <div className="flex shrink-0 items-center border-t border-sidebar-border bg-background/30">
                {runningScripts.map((script, index) => (
                  <button
                    key={`${script.name}-${index}`}
                    onClick={() => setActiveTabIndex(index)}
                    className={`group flex items-center gap-1.5 border-r border-sidebar-border px-2.5 py-1 text-[11px] transition-colors ${
                      index === activeTabIndex
                        ? 'bg-background text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span
                      className={`size-2 rounded-full shrink-0 ${
                        script.exited
                          ? script.exitCode === 0
                            ? 'bg-muted-foreground'
                            : 'bg-red-500'
                          : 'bg-green-500'
                      }`}
                    />
                    <span className="truncate max-w-[50px]">{script.name}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCloseTab(index)
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </button>
                ))}
              </div>

              {/* Mini terminal */}
              <div
                ref={terminalContainerRef}
                className="min-h-[120px] flex-1 overflow-hidden bg-[#111114]"
              />
            </>
          )}

          {/* Empty state */}
          {runningScripts.length === 0 && (
            <div className="flex flex-1 items-center justify-center px-4 py-8">
              <p className="text-center text-[11px] text-muted-foreground">
                Select a script and click play to run it here.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
