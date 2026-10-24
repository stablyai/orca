import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { readFocusedPaneCensus, readProbeStoreState } from './census-probe'
import { summarizeTypingScaleCensus } from './diagnostic-summary'

vi.mock('./echo-instrumentation', () => ({
  listProbePanes: () => [{ id: 'pane', leafId: '1' }],
  paneRootElement: () => null
}))

it('samples canonical live counts and focused agent identity with a raw app root', () => {
  const original = useAppStore.getState()
  try {
    useAppStore.setState({ activeTabId: 'diagnostic' })
    useAppStore.getState().setAgentStatus('diagnostic:1', {
      state: 'working',
      prompt: 'a real diagnostic task',
      agentType: 'codex'
    })
    expect(original).not.toHaveProperty('agentStatusByPaneKey')
    expect(getAgentStatusOwner(useAppStore).getEntry('diagnostic:1')?.state).toBe('working')
    const summary = summarizeTypingScaleCensus({
      state: readProbeStoreState(),
      appVersion: 'test',
      livePaneCount: 1,
      instrumentedPaneCount: 1,
      mountedAgentRowCount: 1,
      storeListenerCount: 1,
      focusedPane: readFocusedPaneCensus()
    })
    expect(summary.agentRows).toMatchObject({ storeLive: 1, storeTotal: 1 })
    expect(readFocusedPaneCensus()?.statusAgentType).toBe('codex')
  } finally {
    useAppStore.getState().removeAgentStatus('diagnostic:1')
    useAppStore.setState(original, true)
  }
})
