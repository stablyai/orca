import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalTitleTracker,
  STALE_WORKING_TITLE_TIMEOUT_MS,
  type TerminalTitleFactMeta
} from '../../../../shared/terminal-output-side-effects'
import { resolvePaneTitleDecision } from './terminal-title-evidence'
import { installTitleSpawnBell } from './pty-connection/title-spawn-bell'
import { clearStaleAgentTabTitleOnConfirmedShell } from './pty-connection/confirmed-shell-agent-title'

import { resolveExplicitTerminalTitleAgentType } from '../../../../shared/terminal-title-agent-type'
import { isNormalizedAgentTitleStamp } from '../../../../shared/agent-title-status'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { terminalGpuAcceleration: 'auto' },
      agentStatusByPaneKey: {},
      runtimePaneTitlesByTabId: { tab: { 1: 'fix the gemini launcher' } },
      tabsByWorktree: {}
    })
  }
}))
vi.mock('./pty-connection/pane-pty-visibility-bind', () => ({
  installPanePtyVisibilityBind: vi.fn()
}))

describe('resolvePaneTitleDecision', () => {
  it.each([
    ['✦ Gemini CLI', '⠋ fix the gemini launcher', '⠋ fix the gemini launcher'],
    ['◇ Gemini CLI', '⠋ add ✦ icon to header', '⠋ add ✦ icon to header'],
    [
      '✋ Gemini CLI',
      '⠋ Codex: fix Gemini terminal behavior',
      '⠋ Codex: fix Gemini terminal behavior'
    ],
    ['✦ Gemini CLI', '✦ Analyze Codex', '✦ Gemini CLI'],
    ['✦ Qoder CLI', '✦ session | Thinking - grok', '✦ session | Thinking - grok'],
    ['▲ Qoder CLI', '▲ session | Action Required - grok', '▲ session | Action Required - grok'],
    ['◇ Qoder CLI CN', '◇ Qoder CLI CN | Idle - grok', '◇ Qoder CLI CN | Idle - grok'],
    ['✦ Qoder CLI CN', '✦ Qoder CLI CN (Codex | Claude Code)', '✦ Qoder CLI CN'],
    ['⠋ Grok', '* | Grok', '* | Grok'],
    ['⠋ Grok', '⠋ Codex: fix parser - grok', '⠋ Codex: fix parser - grok'],
    ['⠋ Grok', '⠋ - Codex: fix parser - grok', '⠋ Grok'],
    // Normalized-only history cannot recover the original task; title-only reuse remains supported.
    ['✦ Gemini CLI', '✦ Gemini CLI', '✦ Gemini CLI']
  ])('corrects only disproved old stamps (%s, %s)', (normalizedTitle, rawTitle, displayTitle) => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle,
      rawTitle,
      displayOwnerAgentType: 'claude',
      rendererOwnerAgentType: null,
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe(displayTitle)
    expect(decision.rawTitle).toBe(rawTitle)
    if (rawTitle === '* | Grok') {
      const replay = resolvePaneTitleDecision({
        normalizedTitle: displayTitle,
        rawTitle: displayTitle,
        displayOwnerAgentType: 'claude',
        rendererOwnerAgentType: null,
        userGpuMode: 'auto'
      })
      expect(resolveExplicitTerminalTitleAgentType(replay.displayTitle)).toBeNull()
      expect(replay).toEqual(decision)
    }
  })

  it.each([
    '✦ Gemini CLI',
    '✋ Gemini CLI',
    '◇ Gemini CLI',
    '✦ Qoder CLI',
    '▲ Qoder CLI',
    '◇ Qoder CLI',
    '✦ Qoder CLI CN',
    '▲ Qoder CLI CN',
    '◇ Qoder CLI CN',
    '⠋ Grok'
  ])(
    'corrects actual raw disproof and preserves normalized-only history for exact output %j',
    (stamp) => {
      expect(isNormalizedAgentTitleStamp(stamp)).toBe(true)
      const decide = (rawTitle: string) =>
        resolvePaneTitleDecision({
          normalizedTitle: stamp,
          rawTitle,
          displayOwnerAgentType: null,
          rendererOwnerAgentType: null,
          userGpuMode: 'auto'
        })
      const raw = '⠋ Codex: repair parser'
      expect(decide(raw)).toEqual(
        resolvePaneTitleDecision({
          normalizedTitle: raw,
          rawTitle: raw,
          displayOwnerAgentType: null,
          rendererOwnerAgentType: null,
          userGpuMode: 'auto'
        })
      )
      expect(decide(stamp).displayTitle).toBe(stamp)
    }
  )

  it.each([
    'Gemini',
    'gemini cli',
    'Qoder CLI',
    'Grok',
    '⠴ Grok',
    'Pi ready',
    'OMP ready',
    '✦ Qoder CLI extra'
  ])('does not treat loose or owner-shaped text %j as an exact output', (title) => {
    expect(isNormalizedAgentTitleStamp(title)).toBe(false)
  })

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
      releaseCommandCodeDoneSettleExecutor: () => {},
      onTitleChange: (_title: string, _raw: string, _meta?: TerminalTitleFactMeta) => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the installed title callback runs; its session dependencies are supplied above.
    installTitleSpawnBell(session as never)
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
      session.releaseCommandCodeDoneSettleExecutor()
      vi.useRealTimers()
    }
  })
  it('derives the display label and the renderer veto from a pane-scoped OMP owner', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'Pi ready',
      rawTitle: '✦ Gemini CLI',
      displayOwnerAgentType: 'omp',
      rendererOwnerAgentType: 'omp',
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe('OMP ready')
    expect(decision.rawTitle).toBe('✦ Gemini CLI')
    // Why: the OMP owner renames the label and vetoes the Gemini glyph fallback.
    expect(decision.rendererPolicy.gpuEnabled).toBe(true)
  })

  it('uses the renderer owner, not the display owner, for the GPU veto', () => {
    const decision = resolvePaneTitleDecision({
      normalizedTitle: 'Pi ready',
      rawTitle: '✦ Gemini CLI',
      // Sticky ownership labels the tab, but only current pane ownership can veto Gemini’s DOM fallback.
      displayOwnerAgentType: 'omp',
      rendererOwnerAgentType: undefined,
      userGpuMode: 'auto'
    })
    expect(decision.displayTitle).toBe('OMP ready')
    expect(decision.rendererPolicy.gpuEnabled).toBe(false)
    expect(decision.rendererPolicy.reason).toBe('agent-compatibility')
  })
})
