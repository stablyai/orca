/**
 * Live-state reads for the typing latency census: focused-pane identity/screen
 * mode, mounted agent-row count, and the zustand listener count. Split from the
 * probe so the sampling loop stays free of store/DOM lookups.
 */
import { useAppStore } from '@/store'
import { listProbePanes, paneRootElement, type ProbePane } from './echo-instrumentation'
import type { FocusedPaneCensus } from './diagnostic-summary'

type ProbeStoreState = {
  activeTabId?: string | null
  paneForegroundAgentByPaneKey?: Record<string, { agent?: string | null }>
  agentStatusByPaneKey?: Record<string, { agentType?: string | null }>
}

export function readProbeStoreState(): (ProbeStoreState & Record<string, unknown>) | null {
  try {
    return useAppStore.getState() as unknown as ProbeStoreState & Record<string, unknown>
  } catch {
    return null
  }
}

function focusedProbePane(panes: readonly ProbePane[]): ProbePane | null {
  const focused = typeof document === 'undefined' ? null : document.activeElement
  const matched = focused
    ? panes.find((pane) => paneRootElement(pane)?.contains(focused) === true)
    : undefined
  return matched ?? panes[0] ?? null
}

export function readFocusedPaneCensus(): FocusedPaneCensus | null {
  const pane = focusedProbePane(listProbePanes())
  if (!pane) {
    return null
  }
  const state = readProbeStoreState()
  const leafId = pane.leafId ?? pane.container?.dataset.leafId ?? null
  const tabId = state?.activeTabId ?? null
  const paneKey = tabId && leafId ? `${tabId}:${leafId}` : null
  const foreground = paneKey ? state?.paneForegroundAgentByPaneKey?.[paneKey] : undefined
  const status = paneKey ? state?.agentStatusByPaneKey?.[paneKey] : undefined
  const bufferType = pane.terminal?.buffer?.active?.type
  return {
    paneId: pane.id ?? null,
    leafId,
    bufferType: bufferType === 'alternate' || bufferType === 'normal' ? bufferType : null,
    cols: pane.terminal?.cols ?? null,
    rows: pane.terminal?.rows ?? null,
    bufferLines: pane.terminal?.buffer?.active?.length ?? null,
    foregroundAgent: foreground?.agent ?? null,
    statusAgentType: status?.agentType ?? null
  }
}

/** Compact-mode cards collapse agents, so only MOUNTED rows carry this attribute. */
export function countMountedAgentRows(): number | null {
  if (typeof document === 'undefined') {
    return null
  }
  try {
    return document.querySelectorAll('[data-agent-send-target]').length
  } catch {
    return null
  }
}

export { readStoreListenerCount } from '@/store/store-listener-census'
