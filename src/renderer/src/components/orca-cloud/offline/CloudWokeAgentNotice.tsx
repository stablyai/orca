import React, { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  AGENT_RELAUNCH_GRACE_MS,
  AGENT_RELAUNCH_WATCH_MS,
  agentEvidenceAt,
  wokeAgentStripState
} from '@/lib/orca-cloud/cloud-woke-agent-strip'
import { CloudWokeProcessesNotice } from './CloudWokeProcessesNotice'

/**
 * The woke-up strip on an agent pane (RA-WAKE): nothing while the host relaunches the agent, gone
 * for good once it has; "Restart <agent>" only if, after the grace, the pane sits at a bare shell.
 */
export function CloudWokeAgentNotice({
  paneKey,
  paneLeafId,
  agentName,
  capturedAt,
  paneAtShellPrompt,
  subscribeScreen,
  onRestart,
  onDismiss
}: {
  paneKey: string
  paneLeafId: string
  agentName: string
  capturedAt: number
  paneAtShellPrompt: () => boolean
  /** Calls back when the pane's screen changes; returns the unsubscribe. */
  subscribeScreen: (onChange: () => void) => () => void
  onRestart: () => void
  onDismiss: () => void
}): React.JSX.Element | null {
  const evidenceAt = useAppStore((state) => agentEvidenceAt(state.agentStatusByPaneKey[paneKey]))
  // Mounted once the workspace is live again; the grace and the watch count from here.
  const [sinceLiveMs, setSinceLiveMs] = useState(0)
  useEffect(() => {
    const grace = setTimeout(() => setSinceLiveMs(AGENT_RELAUNCH_GRACE_MS), AGENT_RELAUNCH_GRACE_MS)
    const watch = setTimeout(() => setSinceLiveMs(AGENT_RELAUNCH_WATCH_MS), AGENT_RELAUNCH_WATCH_MS)
    return () => {
      clearTimeout(grace)
      clearTimeout(watch)
    }
  }, [])
  // The screen as last read on a redraw (null until one): state, so a redraw recomputes the strip.
  const [screenAtPrompt, setScreenAtPrompt] = useState<boolean | null>(null)
  const state = wokeAgentStripState({
    capturedAt,
    evidenceAt,
    sinceLiveMs,
    paneAtShellPrompt: () => screenAtPrompt ?? paneAtShellPrompt()
  })
  const watching = state === 'watching'
  // A screen that was not a shell at the end of the grace may still fall back to one.
  useEffect(
    () => (watching ? subscribeScreen(() => setScreenAtPrompt(paneAtShellPrompt())) : undefined),
    [watching, subscribeScreen, paneAtShellPrompt]
  )
  useEffect(() => {
    if (state === 'relaunched') {
      onDismiss()
    }
  }, [state, onDismiss])
  if (state !== 'restart') {
    return null
  }
  return (
    <CloudWokeProcessesNotice
      action={{ kind: 'restart', agent: agentName }}
      paneLeafId={paneLeafId}
      onAction={onRestart}
      onDismiss={onDismiss}
    />
  )
}
