import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { RunningScript } from './script-runner-types'

type ScriptRunnerTabsProps = {
  runningScripts: RunningScript[]
  activeTabId: number | null
  setActiveTabId: (id: number) => void
  handleCloseTab: (id: number) => void
}

export function ScriptRunnerTabs({
  runningScripts,
  activeTabId,
  setActiveTabId,
  handleCloseTab
}: ScriptRunnerTabsProps): React.JSX.Element | null {
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const activeScript = runningScripts.find((s) => s.id === activeTabId)

  // Mount active tab's terminal to the container
  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container || !activeScript) {
      return
    }

    container.innerHTML = ''
    activeScript.terminal.open(container)
    requestAnimationFrame(() => activeScript.fitAddon.fit())
  }, [activeScript])

  // Resize terminal when container resizes
  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container || !activeScript) {
      return
    }

    const observer = new ResizeObserver(() => {
      activeScript.fitAddon.fit()
      activeScript.transport.resize(activeScript.terminal.cols, activeScript.terminal.rows)
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [activeScript])

  if (runningScripts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-6">
        <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
          Select a script and press{' '}
          <kbd className="rounded border border-border/60 bg-secondary/50 px-1 py-0.5 text-[10px]">
            Play
          </kbd>{' '}
          to run it here
        </p>
      </div>
    )
  }

  return (
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

      <div ref={terminalContainerRef} className="min-h-[120px] flex-1 overflow-hidden" />
    </>
  )
}
