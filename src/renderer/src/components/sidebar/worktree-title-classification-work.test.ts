import { describe, expect, it, vi } from 'vitest'
import * as AgentNameTokenMatchModule from '../../../../shared/agent-name-token-match'
import { resolveExplicitTerminalTitleAgentType } from '../../../../shared/terminal-title-agent-type'
import * as Evidence from '../../../../shared/agent-title-evidence'
import * as Frames from '../../../../shared/agent-title-name-anchoring'
import { createTerminalTitleTracker } from '../../../../shared/terminal-output-side-effects'
import { resolveTabAgentFromSignalSnapshot } from '../../../../shared/tab-agent-from-signals'
import { buildTitleDerivedAgentRows } from './worktree-title-derived-agent-rows'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

import type * as OpenCode from '../../../../shared/opencode-terminal-title'
import * as Status from '../../../../shared/agent-title-status'
import * as Wrappers from '../../../../shared/terminal-title-wrapper-segments'
import * as Ingress from '../terminal-pane/terminal-title-evidence'

const work = vi.hoisted((): { strict: boolean; frames: number[] } => ({
  strict: false,
  frames: []
}))
vi.mock('../../../../shared/opencode-terminal-title', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenCode>()
  return {
    ...actual,
    isOpenCodeNativeTitle: vi.fn((title: string) => {
      if (work.strict) {
        work.frames.push(title.length)
      }
      return actual.isOpenCodeNativeTitle(title)
    })
  }
})
vi.mock('../../../../shared/agent-title-status', async (importOriginal) => {
  const actual = await importOriginal<typeof Status>()
  return { ...actual, normalizeTerminalTitle: vi.fn(actual.normalizeTerminalTitle) }
})
vi.mock('../../../../shared/terminal-title-wrapper-segments', async (importOriginal) => {
  const actual = await importOriginal<typeof Wrappers>()
  return { ...actual, getWrapperTitleSegments: vi.fn(actual.getWrapperTitleSegments) }
})
vi.mock('../terminal-pane/terminal-title-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof Ingress>()
  return { ...actual, resolvePaneTitleDecision: vi.fn(actual.resolvePaneTitleDecision) }
})

vi.mock('../../../../shared/agent-title-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof Evidence>()
  return {
    ...actual,
    collectExplicitAgentTitleEvidence: vi.fn((title: string) => {
      work.strict = true
      try {
        return actual.collectExplicitAgentTitleEvidence(title)
      } finally {
        work.strict = false
      }
    })
  }
})
vi.mock('../../../../shared/agent-title-name-anchoring', async (importOriginal) => {
  const actual = await importOriginal<typeof Frames>()
  return {
    ...actual,
    agentForNativeFrame: vi.fn(actual.agentForNativeFrame),
    isNeutralAgentTitleWrapper: vi.fn(actual.isNeutralAgentTitleWrapper)
  }
})

// Count the leaf titleHasAgentName regex to measure unchanged-title work across store writes.
vi.mock('../../../../shared/agent-name-token-match', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentNameTokenMatchModule>()
  return { ...actual, titleHasAgentName: vi.fn(actual.titleHasAgentName) }
})

const classifierCalls = vi.mocked(AgentNameTokenMatchModule.titleHasAgentName)

const STORE_WRITES = 50

describe('terminal title production classification work', () => {
  it.each([
    'native',
    'wrap8',
    'wrap9',
    'wrap200',
    'named',
    'barrier',
    'ascii-barrier',
    'dense',
    'sparse',
    'qoder',
    'gemini',
    'grok',
    'pi',
    'old-stamp'
  ])('bounds production OSC/projection work at N/10N: %s', (scenario) => {
    const strict = vi.mocked(Evidence.collectExplicitAgentTitleEvidence)
    const frames = vi.mocked(Frames.agentForNativeFrame)
    const headers = vi.mocked(Frames.isNeutralAgentTitleWrapper)
    const normalize = vi.mocked(Status.normalizeTerminalTitle)
    const ingress = vi.mocked(Ingress.resolvePaneTitleDecision)
    const inherited = vi.mocked(Wrappers.getWrapperTitleSegments)
    const clear = () => {
      for (const spy of [strict, frames, headers, normalize, ingress, inherited, classifierCalls]) {
        spy.mockClear()
      }
      work.frames = []
    }
    const counts = () => ({
      strict: strict.mock.calls.length,
      leaf: frames.mock.calls.length + classifierCalls.mock.calls.length,
      boundaries: headers.mock.calls.length,
      headerSpan: headers.mock.calls.reduce((sum, [header]) => sum + header.length, 0),
      full: work.frames.length,
      fullSpan: work.frames.reduce((sum, length) => sum + length, 0),
      normalize: normalize.mock.calls.length,
      ingress: ingress.mock.calls.length
    })
    const inheritedBudget = () =>
      inherited.mock.calls.reduce(
        (total, [title]) => {
          const boundaries = [...title.matchAll(/ \| /g)]
          const materialized = boundaries.reduce(
            (sum, match) => sum + title.length - match.index - 3,
            title.length
          )
          expect(materialized).toBeLessThanOrEqual((boundaries.length + 1) * title.length)
          return {
            calls: total.calls + 1,
            spans: total.spans + materialized,
            comparisonBound:
              total.comparisonBound +
              ((boundaries.length * (boundaries.length + 1)) / 2) * title.length
          }
        },
        { calls: 0, spans: 0, comparisonBound: 0 }
      )
    const measure = (population: number) => {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const owner = scenario === 'pi' ? 'omp' : 'claude'
      const rawTitle = (index: number) => {
        const id = `memo-${String(population).padStart(3, '0')}-${String(index).padStart(3, '0')}`
        const payload = `${id} | a | b | c | d | e | f | g | h | Codex`
        if (scenario.startsWith('wrap')) {
          return `${'x | '.repeat(Number(scenario.slice(4)))}OC | ${payload}`
        }
        if (scenario === 'native') {
          return `tmux | 🐋 ${payload}`
        }
        if (scenario === 'named') {
          return `tmux | Codex: ${payload}`
        }
        if (scenario === 'barrier') {
          return `tmux | ⠋ fix ${payload}`
        }
        if (scenario === 'ascii-barrier') {
          return `${'x | '.repeat(200)}${id} | ${index % 2 ? '*' : '.'} | ${index % 2 ? ' Grok' : 'Droid'}`
        }
        if (scenario === 'dense') {
          return `${'x | '.repeat(200)}⠋ ${id}`
        }
        if (scenario === 'sparse') {
          return `${'x'.repeat(800)}⠋ ${id}`
        }
        if (scenario === 'qoder') {
          return `✦ Qoder CLI CN (${id}) | Thinking`
        }
        if (scenario === 'gemini') {
          return `✦ Analyze ${id}`
        }
        if (scenario === 'grok') {
          return `⠴ - Codex: ${id} - grok`
        }
        if (scenario === 'pi') {
          return `⠴ π - ${id} - cwd`
        }
        return `✦ ${id} | Thinking - grok`
      }
      const expectedIcon =
        scenario === 'native'
          ? 'dsh'
          : scenario.startsWith('wrap')
            ? 'opencode'
            : scenario === 'named'
              ? 'codex'
              : scenario === 'qoder'
                ? 'qoder-cn'
                : scenario === 'gemini'
                  ? 'gemini'
                  : scenario === 'grok'
                    ? 'grok'
                    : scenario === 'pi'
                      ? 'omp'
                      : 'claude'
      const expectedRow = scenario === 'native' || scenario === 'qoder' ? 'unknown' : expectedIcon
      const tabs: TerminalTab[] = Array.from({ length: population }, (_, index) => ({
        id: `tab-${index}`,
        worktreeId: 'memo',
        ptyId: `pty-${index}`,
        title: '',
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 0,
        launchAgent: owner
      }))
      const observedRaw: string[] = []
      const trackers = tabs.map((tab) =>
        createTerminalTitleTracker({
          onTitle: (normalizedTitle, raw) => {
            expect(raw.length).toBeLessThanOrEqual(1024)
            observedRaw.push(raw)
            if (
              observedRaw.length <= population &&
              (scenario === 'dense' || scenario === 'sparse')
            ) {
              expect(raw.length).toBe(800 + '⠋ memo-010-000'.length)
            }
            tab.title = Ingress.resolvePaneTitleDecision({
              normalizedTitle: scenario === 'old-stamp' ? '✦ Qoder CLI' : normalizedTitle,
              rawTitle: raw,
              displayOwnerAgentType: owner,
              displayOwnerIsLaunch: true,
              rendererOwnerAgentType: owner,
              userGpuMode: 'auto'
            }).displayTitle
          }
        })
      )
      const project = () => ({
        icons: tabs.map((tab) =>
          resolveTabAgentFromSignalSnapshot({
            title: tab.title,
            hookAgent: null,
            focusedCompletedHookAgent: owner,
            launchAgent: owner
          })
        ),
        rows: buildTitleDerivedAgentRows({
          tabs,
          ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.ptyId!]])),
          terminalLayoutsByTabId: Object.fromEntries(
            tabs.map((tab) => [
              tab.id,
              { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
            ])
          ),
          seenPaneKeys: new Set(),
          now: 1
        })
      })
      try {
        clear()
        trackers.forEach((tracker, index) => tracker.handleChunk(`\x1b]0;${rawTitle(index)}\x07`))
        // Exact equality proves deep inputs reach the tracker without OSC truncation.
        expect(observedRaw).toEqual(tabs.map((_, index) => rawTitle(index)))
        const first = project()
        expect(first.icons).toEqual(Array(population).fill(expectedIcon))
        expect(first.rows.map((row) => row.agentType)).toEqual(
          Array(scenario === 'ascii-barrier' ? population / 2 : population).fill(expectedRow)
        )
        if (scenario === 'ascii-barrier') {
          expect(tabs.map((tab) => resolveExplicitTerminalTitleAgentType(tab.title))).toEqual(
            Array(population).fill(null)
          )
        }
        const cold = counts()
        expect(cold.strict).toBeLessThanOrEqual(3 * population + 10)
        expect(cold.normalize).toBeLessThanOrEqual(2 * population)
        expect(cold.ingress).toBe(population)
        const coldSpan = strict.mock.calls.reduce((sum, [title]) => sum + title.length, 0)
        expect(cold.headerSpan).toBeLessThanOrEqual(coldSpan)
        expect(cold.full).toBe(cold.strict)
        expect(cold.full).toBeLessThanOrEqual(8 * cold.strict)
        expect(cold.fullSpan).toBeLessThanOrEqual(8 * coldSpan)
        const inheritedCold = inheritedBudget()
        clear()
        for (let write = 0; write < STORE_WRITES; write += 1) {
          project()
        }
        expect(Object.values(counts())).toEqual(Array(8).fill(0))
        const inheritedWarm = inheritedBudget()
        if (scenario === 'pi') {
          expect(inheritedWarm.calls).toBeGreaterThan(0)
        }
        clear()
        trackers[0].handleChunk(
          `\x1b]0;Fix Codex ${scenario}-${String(population).padStart(3, '0')} - grok\x07`
        )
        const changed = project()
        expect(changed.icons[0]).toBe('grok')
        expect(changed.rows[0]).toMatchObject({ agentType: 'grok', entry: { prompt: 'Grok' } })
        expect(changed.icons.slice(1)).toEqual(Array(population - 1).fill(expectedIcon))
        return { cold, inheritedCold, inheritedWarm, changed: counts() }
      } finally {
        trackers.forEach((tracker) => tracker.dispose())
      }
    }
    const n = measure(10)
    const tenN = measure(100)
    for (const category of [
      'strict',
      'leaf',
      'boundaries',
      'headerSpan',
      'full',
      'fullSpan',
      'normalize',
      'ingress'
    ] as const) {
      expect(tenN.cold[category]).toBeLessThanOrEqual(10 * n.cold[category] + 10)
    }
    expect(tenN.inheritedCold.calls).toBeLessThanOrEqual(10 * n.inheritedCold.calls + 10)
    expect(tenN.inheritedCold.spans).toBeLessThanOrEqual(10 * n.inheritedCold.spans + 10240)
    expect(tenN.inheritedCold.comparisonBound).toBeLessThanOrEqual(
      10 * n.inheritedCold.comparisonBound + 10240
    )
    expect(tenN.inheritedWarm.spans).toBeLessThanOrEqual(10 * n.inheritedWarm.spans)
    expect(tenN.inheritedWarm.calls).toBeLessThanOrEqual(10 * n.inheritedWarm.calls)
    expect(tenN.changed).toEqual(n.changed)
    console.info('production title work', scenario, JSON.stringify({ n, tenN }))
  })
})
