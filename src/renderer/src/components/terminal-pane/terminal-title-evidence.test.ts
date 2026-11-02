import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalTitleTracker,
  STALE_WORKING_TITLE_TIMEOUT_MS
} from '../../../../shared/terminal-output-side-effects'
import { resolvePaneTitleDecision } from './terminal-title-evidence'

import { resolveExplicitTerminalTitleAgentType } from '../../../../shared/terminal-title-agent-type'
import { isNormalizedAgentTitleStamp } from '../../../../shared/agent-title-status'

import { TerminalResidentRegistry } from './terminal-resident-registry'
import { createTerminalResidentPolicy } from './terminal-resident-policy'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { LEAF_1 } from './pty-connection-test-pane-fixtures'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

let mockStoreState: StoreState
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState, subscribe: () => () => {} }
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
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState.tabsByWorktree['wt-1'] = [
      { id: 'tab-1', ptyId: 'tab-pty', defaultTitle: 'Terminal 1' }
    ]
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'fix the gemini launcher' } }
    mockStoreState.agentLaunchConfigByPaneKey[makePaneKey('tab-1', LEAF_1)] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'claude' }
    }
    await installTerminalTestGlobals()
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh')
    const registry = new TerminalResidentRegistry<ReturnType<typeof createTerminalResidentPolicy>>()
    const resident = registry.admit(
      {
        endpoint: 'local',
        executionHost: 'local',
        ptyId: 'tab-pty',
        incarnationId: 'title-facts',
        runtimeId: null
      },
      (captured) =>
        createTerminalResidentPolicy(
          {
            paneKey: makePaneKey('tab-1', LEAF_1),
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            cwd: '/tmp/wt-1'
          },
          captured.identity,
          () => captured.isLive,
          {
            setCacheTimerStartedAt: vi.fn(),
            markTerminalBell: vi.fn(),
            dispatchNotification: vi.fn()
          }
        )
    )
    const startup = vi.spyOn(
      resident.policy.foreground.paneForegroundAgentTracker,
      'onAgentStartupObserved'
    )
    const completion = vi.spyOn(resident.policy.completion, 'observeTitle')
    const detach = resident.policy.attachPresentation({
      paneId: 1,
      isVisible: () => false,
      showTitle: (title) => {
        mockStoreState.setRuntimePaneTitle('tab-1', 1, title)
        mockStoreState.updateTabTitle('tab-1', title)
      },
      resetInputModes: vi.fn(),
      setFocusReportSuppression: vi.fn(),
      clearFocusReportSuppression: vi.fn(),
      markBracketedPasteInterrupted: vi.fn(),
      onAgentExited: vi.fn(),
      setMode2031: vi.fn()
    })
    expect(resident.isLive).toBe(true)
    const tracker = createTerminalTitleTracker({
      onTitle: (title, raw, meta) => {
        facts.push([title, raw, meta])
        resident.policy.callbacks.onTitleChange(title, raw, meta)
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
      expect(mockStoreState.updateTabTitle).toHaveBeenLastCalledWith(
        'tab-1',
        'fix the gemini launcher'
      )
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
      resident.policy.foreground.handleCommandFinished(0)
      await vi.advanceTimersByTimeAsync(350)
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith('tab-pty')
      expect(mockStoreState.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'Terminal 1')
      expect(mockStoreState.updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'Terminal 1')
    } finally {
      tracker.dispose()
      detach()
      registry.retire(resident)
      await restoreTerminalTestGlobals()
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
