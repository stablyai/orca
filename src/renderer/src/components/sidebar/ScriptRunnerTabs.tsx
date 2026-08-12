import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { RunningScript } from './script-runner-types'

type ScriptRunnerTabsProps = {
  runningScripts: RunningScript[]
  activeTabId: number | null
  setActiveTabId: (id: number) => void
  handleCloseTab: (id: number) => void
}

/**
 * Tab strip and terminal area for the running scripts.
 *
 * Shows a hint instead when nothing has been run yet. Every pane stays mounted
 * so a background script keeps streaming into its own scrollback.
 */
export function ScriptRunnerTabs({
  runningScripts,
  activeTabId,
  setActiveTabId,
  handleCloseTab
}: ScriptRunnerTabsProps): React.JSX.Element | null {
  const activeScript = runningScripts.find((s) => s.id === activeTabId)

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
          <div
            key={script.id}
            className={`group flex shrink-0 items-center border-r border-sidebar-border ${
              script.id === activeTabId ? 'bg-background text-foreground' : 'text-muted-foreground'
            }`}
          >
            <button
              type="button"
              onClick={() => setActiveTabId(script.id)}
              className="flex min-w-0 items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors hover:text-foreground"
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
            </button>
            <button
              type="button"
              aria-label={`Close ${script.name}`}
              onClick={() => handleCloseTab(script.id)}
              className="mr-1 rounded-sm p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
            >
              <X className="size-2.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="min-h-[120px] flex-1 overflow-hidden">
        {runningScripts.map((script) => (
          <ScriptTerminalPane
            key={script.id}
            script={script}
            active={script.id === activeScript?.id}
          />
        ))}
      </div>
    </>
  )
}

/**
 * Host element for one script's xterm instance.
 *
 * Opens the terminal on first activation and refits it on container resize,
 * forwarding the new dimensions to the PTY so wrapping stays correct.
 */
function ScriptTerminalPane({
  script,
  active
}: {
  script: RunningScript
  active: boolean
}): React.JSX.Element {
  const terminalContainerRef = useRef<HTMLDivElement>(null)
  const openedRef = useRef(false)

  useEffect(() => {
    const container = terminalContainerRef.current
    if (!container || !active) {
      return
    }

    if (!openedRef.current) {
      script.terminal.open(container)
      openedRef.current = true
    }

    const fit = (): void => {
      script.fitAddon.fit()
      script.transport.resize(script.terminal.cols, script.terminal.rows)
    }

    requestAnimationFrame(fit)

    const observer = new ResizeObserver(fit)
    observer.observe(container)
    return () => observer.disconnect()
  }, [active, script])

  return (
    <div
      ref={terminalContainerRef}
      className={active ? 'h-full min-h-[120px] overflow-hidden' : 'hidden'}
    />
  )
}
