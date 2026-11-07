import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalTitleTracker,
  STALE_WORKING_TITLE_TIMEOUT_MS,
  type TerminalTitleFactMeta
} from '../../../../../../shared/terminal/output/terminal-output-side-effects'
import { resolvePaneTitleDecision } from '../../titles/terminal-title-evidence'
import { installPaneTitleObservation } from './pane-title-observation'
import { clearStaleAgentTabTitleOnConfirmedShell } from './confirmed-shell-agent-title'

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      settings: { terminalGpuAcceleration: 'auto' },
      agentStatusByPaneKey: {},
      runtimePaneTitlesByTabId: { tab: { 1: 'fix the gemini launcher' } },
      tabsByWorktree: {}
    })
  }
}))

describe('pane title observation stale facts', () => {
  it('keeps current timer facts cleared with equal raw/display input and existing provenance', async () => {
    vi.useFakeTimers()
    const facts: [string, string, unknown][] = []
    const startup = vi.fn()
    const completion = vi.fn()
    const session = {
      cacheKey: 'tab:leaf',
      pane: { id: 1 },
      deps: {
        tabId: 'tab',
        worktreeId: 'wt',
        setRuntimePaneTitle: vi.fn(),
        updateTabTitle: vi.fn()
      },
      manager: { getActivePane: () => ({ id: 1 }), setPaneGpuRendering: vi.fn() },
      getAuthoritativePaneAgent: () => 'claude',
      getPaneScopedRendererOwner: () => 'claude',
      syncAgentTaskCompleteTrackingEnabled: () => true,
      shouldSuppressTitleCompletionForFreshHook: () => false,
      paneForegroundAgentTracker: { onAgentStartupObserved: startup },
      agentCompletionCoordinator: { observeTitle: completion },
      hasConsideredInitialCacheTimerSeed: true,
      neutralTerminalTitle: () => 'Terminal 1',
      onTitleChange: (_title: string, _raw: string, _meta?: TerminalTitleFactMeta) => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the installed title callback runs; its session dependencies are supplied above.
    installPaneTitleObservation(session as never)
    const tracker = createTerminalTitleTracker({
      onTitle: (title, raw, meta) => {
        facts.push([title, raw, meta])
        session.onTitleChange(title, raw, meta)
      }
    })
    try {
      tracker.handleChunk('\x1b]0;⠋ fix the gemini launcher\x07')
      tracker.handleChunk('more output\n')
      await vi.advanceTimersByTimeAsync(STALE_WORKING_TITLE_TIMEOUT_MS)
      expect(facts).toEqual([
        ['⠋ fix the gemini launcher', '⠋ fix the gemini launcher', undefined],
        ['fix the gemini launcher', 'fix the gemini launcher', { staleWorkingTitleClear: true }]
      ])
      expect(startup).not.toHaveBeenCalled()
      expect(completion).toHaveBeenCalledExactlyOnceWith('⠋ fix the gemini launcher')
      expect(session.deps.updateTabTitle).toHaveBeenLastCalledWith('tab', 'fix the gemini launcher')
      const [normalizedTitle, rawTitle] = facts[1]
      expect(
        resolvePaneTitleDecision({
          normalizedTitle,
          rawTitle,
          displayOwnerAgentType: 'claude',
          rendererOwnerAgentType: null,
          userGpuMode: 'auto'
        }).displayTitle
      ).toBe('fix the gemini launcher')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reset reads only pane/deps/manager/default-title fields supplied above.
      clearStaleAgentTabTitleOnConfirmedShell(session as never)
      expect(session.deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab', 1, 'Terminal 1')
      expect(session.deps.updateTabTitle).toHaveBeenLastCalledWith('tab', 'Terminal 1')
    } finally {
      tracker.dispose()
      vi.useRealTimers()
    }
  })
})
