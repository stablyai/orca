import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/hooks/use-now'
import type { Terminal } from '@xterm/xterm'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalPaneController } from '../controller/use-terminal-pane-controller'
import {
  AGENT_STARTING_DELAY_MS,
  agentStartingPhase,
  isAgentLaunchLeaf,
  terminalHasVisibleContent
} from './agent-starting-state'

/** Terminals that have drawn something: once they have, the status never comes back. */
const drawn = new WeakSet<Terminal>()

function useTerminalStillBlank(terminal: Terminal): boolean {
  const [blank, setBlank] = useState(
    () => !drawn.has(terminal) && !terminalHasVisibleContent(terminal.buffer)
  )
  useEffect(() => {
    if (!blank) {
      drawn.add(terminal)
      return
    }
    const check = (): void => {
      if (terminalHasVisibleContent(terminal.buffer)) {
        drawn.add(terminal)
        setBlank(false)
      }
    }
    check()
    const subscription = terminal.onWriteParsed(check)
    return () => subscription.dispose()
  }, [terminal, blank])
  return blank
}

export function AgentStartingStatus({
  agent,
  startedAt
}: {
  agent: TuiAgent
  startedAt: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const now = useNow(1_000)
  const elapsed = Math.max(0, now - startedAt)
  if (elapsed < AGENT_STARTING_DELAY_MS) {
    return null
  }
  const name = TUI_AGENT_DISPLAY_NAMES[agent] ?? agent
  const phase = agentStartingPhase(elapsed)
  return (
    <div
      data-agent-starting=""
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
    >
      <div
        role="status"
        className="flex flex-col items-center gap-1.5 text-center text-sm text-muted-foreground"
      >
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          <span className="font-medium text-foreground">
            {phase === 'starting'
              ? t('terminalPane.agentStarting.title', 'Starting {{agent}}…', { agent: name })
              : t('terminalPane.agentStarting.still', 'Still starting {{agent}}…', { agent: name })}
          </span>
          <span className="tabular-nums" aria-hidden="true">
            {Math.floor(elapsed / 1000)}s
          </span>
        </span>
        {phase === 'slow' ? (
          <span className="text-xs">
            {t(
              'terminalPane.agentStarting.slow',
              'Taking longer than usual. It opens here as soon as it’s ready.'
            )}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function PaneAgentStarting({
  terminal,
  agent,
  container,
  paneId
}: {
  terminal: Terminal
  agent: TuiAgent
  container: HTMLElement
  paneId: number
}): React.JSX.Element | null {
  const blank = useTerminalStillBlank(terminal)
  // Counted from when this pane began waiting; the clock stops mattering once it draws.
  const [startedAt] = useState(() => Date.now())
  if (!blank) {
    return null
  }
  return createPortal(
    <AgentStartingStatus agent={agent} startedAt={startedAt} />,
    container,
    `agent-starting-${paneId}`
  )
}

/** "Starting Claude…" over a launched agent's pane until the agent draws its first frame. */
export function AgentStartingPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const { managedPanes, terminalTab, paneProcessExitsByPaneId } = controller
  const agent = terminalTab?.launchAgent
  // Read once per render: a launch older than the window never shows the status.
  const [mountedAt] = useState(() => Date.now())
  if (!agent) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane) =>
        // An exited agent shows its exit overlay (the error), never "Starting".
        isAgentLaunchLeaf(terminalTab, pane.leafId, managedPanes.length, mountedAt) &&
        !paneProcessExitsByPaneId[pane.id] ? (
          <PaneAgentStarting
            key={pane.id}
            terminal={pane.terminal}
            agent={agent}
            container={pane.container}
            paneId={pane.id}
          />
        ) : null
      )}
    </>
  )
}
