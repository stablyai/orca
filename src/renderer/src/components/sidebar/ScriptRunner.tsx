import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '@/store'
import { createIpcPtyTransport } from '@/components/terminal-pane/pty-transport'
import { type RunningScript, getNextScriptId } from './script-runner-types'
import { usePackageScripts, detectPackageManager } from './usePackageScripts'
import { ScriptRunnerTabs } from './ScriptRunnerTabs'
import { ScriptRunnerControls } from './ScriptRunnerControls'

export default function ScriptRunner(): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const [packageManager, setPackageManager] = useState<'pnpm' | 'yarn' | 'npm'>('npm')
  const [selectedScript, setSelectedScript] = useState<string | null>(null)
  const [commandOverrides, setCommandOverrides] = useState<Record<string, string>>({})
  const [runningScripts, setRunningScripts] = useState<RunningScript[]>([])
  const [activeTabId, setActiveTabId] = useState<number | null>(null)
  const runningScriptsRef = useRef(runningScripts)
  runningScriptsRef.current = runningScripts

  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)

  const worktreePath = React.useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const wt = worktrees.find((w) => w.id === activeWorktreeId)
      if (wt) {
        return wt.path
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  const { scripts, loading } = usePackageScripts(worktreePath)

  useEffect(() => {
    if (!worktreePath) {
      return
    }
    void detectPackageManager(worktreePath).then(setPackageManager)
  }, [worktreePath])

  useEffect(() => {
    if (scripts && !selectedScript) {
      const first = Object.keys(scripts)[0]
      if (first) {
        setSelectedScript(first)
      }
    }
  }, [scripts, selectedScript])

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
    if (!selectedScript || !worktreePath || !scripts) {
      return
    }

    const command = commandOverrides[selectedScript] ?? `${packageManager} run ${selectedScript}`

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 12,
      fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", monospace',
      fontWeight: '300',
      scrollback: 5000,
      macOptionIsMeta: true
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const transport = createIpcPtyTransport({ cwd: worktreePath })
    const scriptId = getNextScriptId()

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
      transport.connect({
        url: '',
        cols: terminal.cols,
        rows: terminal.rows,
        callbacks: {
          onData: (data) => terminal.write(data),
          onConnect: () => transport.sendInput(`${command}\r`),
          onExit: (code) => {
            setRunningScripts((prev) =>
              prev.map((s) => (s.id === scriptId ? { ...s, exited: true, exitCode: code } : s))
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
      if (!script || script.exited) {
        return prev
      }
      script.transport.disconnect()
      return prev.map((s) => (s.id === scriptId ? { ...s, exited: true, exitCode: -1 } : s))
    })
  }, [])

  const handleCloseTab = useCallback(
    (scriptId: number) => {
      const script = runningScripts.find((s) => s.id === scriptId)
      if (!script) {
        return
      }
      if (!script.exited) {
        script.transport.disconnect()
      }
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

  const handleCommandOverride = useCallback((scriptName: string, command: string) => {
    setCommandOverrides((prev) => ({ ...prev, [scriptName]: command }))
  }, [])

  if (!worktreePath || (!scripts && !loading)) {
    return null
  }

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
        {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
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
          <ScriptRunnerControls
            scriptNames={scriptNames}
            selectedScript={selectedScript}
            setSelectedScript={setSelectedScript}
            currentCommand={currentCommand}
            isRunning={isRunning}
            runningScripts={runningScripts}
            packageManager={packageManager}
            onRun={handleRun}
            onStop={handleStop}
            onCommandOverride={handleCommandOverride}
          />

          <ScriptRunnerTabs
            runningScripts={runningScripts}
            activeTabId={activeTabId}
            setActiveTabId={setActiveTabId}
            handleCloseTab={handleCloseTab}
          />
        </div>
      )}
    </div>
  )
}
