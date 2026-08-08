import { describe, expect, it } from 'vitest'

import {
  terminalOutputContainsEastAsianRendererRisk,
  windowsEastAsianOutputPrefersRenderRefresh
} from './terminal-complex-script'

/**
 * #12164 comment 1 / #5921: agent output containing double-width glyphs renders
 * duplicated character-by-character, while ASCII in the same line stays clean.
 * No IME, no composition, no keystroke — the user never types the CJK; Codex (and
 * Antigravity CLI) emit it. The reporter characterised the dynamic as incremental
 * repaint: a block flashes duplicated, then normalises once the next repaint moves on.
 *
 * `be3f30e2f8d` ("Fix Windows CJK terminal repaint and ConPTY wrap markers", PR #6890)
 * is the named owner. Its whole delta on this path is a second, independent disjunct:
 * before it, a wide-glyph chunk elected a repaint only when the user had recently
 * typed; after it, native ConPTY agent output elects one with no keystroke at all.
 *
 * Recorded output, transcribed verbatim from the issue threads (SHA-256 of the exact
 * UTF-8 literal above each pair). `.tmp/` is gitignored, so these are inlined rather
 * than loaded; they are the *actual*, matched here against the production detector.
 *
 * Split from `terminal-complex-script.test.ts` (406 lines against an 800-line cap) for
 * cohesion, not to stay under `max-lines`.
 */

// #5921, StillHanWind, 2026-06-20, Orca v1.4.83, Windows/PowerShell, Codex CLI.
// clean b6b001338d44efe028ef8253fdeec4da0e87fce52cfbc224ebd07cceed9b4ffb
// actual d5c3ec6a9f54e48674d4c45defc7a327db2cf65f07e6b3be877e6f61b12aa014
const CHINESE_CLEAN = '如果还在主 checkout，请创建前端/设计专用 worktree：'
const CHINESE_CORRUPTED =
  '如如果果还还在在主主 checkout，，请请创创建建前前端端/设设计计专专用用 worktree：：'

// #5921 reopen request, pobbye-star, 2026-07-25, Windows 11 build 26100 — i.e. after
// #6890 shipped. Same shape in Korean.
// clean 017d41fc33b39d24d73d0178eb93277cfa3528fe810ee23df5a3793a92d41cb4
// actual 06fba393f10c436c0e84f658e85453732c982efc0e894c161b4a4cbe56f34984
const KOREAN_HEADING_CLEAN = '### 1. 매뉴얼 분석 결과 [확정]'
const KOREAN_HEADING_CORRUPTED = '### 1. 매매뉴뉴얼얼 분분석석 결결과과 [확확정정]'

// clean 04c3a0660e8921ce4202af3803eecbc9093a8e78863cd19fb960c3ea28af707f
// actual 580a5fc229ea2d5b9879ee03430a53691c17948d679b5aa8cce67696279191cd
const KOREAN_BODY_CLEAN =
  '제시해 주신 매뉴얼은 예스스트레이더의 자바스크립트(JavaScript) 기반 시스템 트레이딩/자동매매'
const KOREAN_BODY_CORRUPTED =
  '제제시시해해 주주신신 매매뉴뉴얼얼은은 예예스스스스트트레레이이더더의의 자자바바스크크립립트트(JavaScript) 기기반반 시시스템템 트트레레이이딩딩/자자동동매매매매'

const RECORDED_OUTPUT = [
  { issue: '#5921 zh-CN', clean: CHINESE_CLEAN, corrupted: CHINESE_CORRUPTED },
  { issue: '#5921 ko heading', clean: KOREAN_HEADING_CLEAN, corrupted: KOREAN_HEADING_CORRUPTED },
  { issue: '#5921 ko body', clean: KOREAN_BODY_CLEAN, corrupted: KOREAN_BODY_CORRUPTED }
]

const MAX_INTERACTIVE_REDRAW_CHARS = 128 * 1024

/** Agent streaming its own output: native ConPTY, user has not touched the keyboard. */
const UNTYPED_AGENT_OUTPUT = {
  isWindowsClient: true,
  isNativeWindowsConpty: true,
  hadRecentInput: false,
  maxInteractiveRedrawChars: MAX_INTERACTIVE_REDRAW_CHARS
}

const TYPED_INPUT_ECHO = { ...UNTYPED_AGENT_OUTPUT, hadRecentInput: true }

/**
 * The predicate as it stood immediately before #6890, transcribed from
 * `git show be3f30e2f8d^:src/renderer/src/components/terminal-pane/pty-connection.ts`
 * lines 3091-3094. This is the mutation arm — reverting #6890 on this path is exactly
 * dropping the `isNativeWindowsConpty` disjunct.
 */
function pre6890PrefersRenderRefresh(data: string, state: typeof UNTYPED_AGENT_OUTPUT): boolean {
  return (
    state.isWindowsClient &&
    state.hadRecentInput &&
    data.length <= state.maxInteractiveRedrawChars &&
    terminalOutputContainsEastAsianRendererRisk(data)
  )
}

/**
 * Split a line into the maximal runs the PTY repaints as units, classified by the
 * production detector itself rather than by a width table of our own.
 */
function segmentByRendererRiskClass(line: string): { risky: boolean; text: string }[] {
  const runs: { risky: boolean; text: string }[] = []
  for (const character of line) {
    const risky = terminalOutputContainsEastAsianRendererRisk(character)
    const open = runs.at(-1)
    if (open && open.risky === risky) {
      open.text += character
    } else {
      runs.push({ risky, text: character })
    }
  }
  return runs
}

describe('recorded CJK agent output vs the repaint detector', () => {
  it('corrupts a run if and only if the detector flags it, across all recorded output', () => {
    const verdicts: { corrupted: boolean; risky: boolean }[] = []
    for (const { issue, clean, corrupted } of RECORDED_OUTPUT) {
      const cleanRuns = segmentByRendererRiskClass(clean)
      const corruptedRuns = segmentByRendererRiskClass(corrupted)
      // Corruption never moves a run across the class boundary, so the two segmentations align.
      expect(
        corruptedRuns.map((run) => run.risky),
        issue
      ).toEqual(cleanRuns.map((run) => run.risky))
      cleanRuns.forEach((run, index) => {
        verdicts.push({ corrupted: run.text !== corruptedRuns[index]?.text, risky: run.risky })
      })
    }

    // Assert the precondition before the correspondence: both classes are actually present,
    // so neither half of the biconditional is vacuously satisfied.
    expect(verdicts.filter((verdict) => verdict.risky)).toHaveLength(17)
    expect(verdicts.filter((verdict) => !verdict.risky)).toHaveLength(16)

    expect(verdicts.filter((verdict) => verdict.corrupted)).toHaveLength(17)
    for (const verdict of verdicts) {
      expect(verdict.corrupted).toBe(verdict.risky)
    }
  })

  it('leaves the ASCII in the same line byte-identical', () => {
    // The reporter's own negative: "English text such as `checkout` is not duplicated."
    // It is co-located with the corrupted CJK, not a separate run.
    const narrowRuns = RECORDED_OUTPUT.flatMap(({ clean, corrupted }) => {
      const corruptedRuns = segmentByRendererRiskClass(corrupted)
      return segmentByRendererRiskClass(clean)
        .map((run, index) => ({ ...run, after: corruptedRuns[index]?.text }))
        .filter((run) => !run.risky)
    })

    expect(narrowRuns.map((run) => run.text)).toContain(' checkout')
    expect(narrowRuns.map((run) => run.text)).toContain('(JavaScript) ')
    for (const run of narrowRuns) {
      expect(run.after).toBe(run.text)
      expect(windowsEastAsianOutputPrefersRenderRefresh(run.text, UNTYPED_AGENT_OUTPUT)).toBe(false)
    }
  })

  it('does not double every character in a corrupted run', () => {
    // The doubling tracks the repaint region, not the character: `자바스크립트` loses one
    // `스` and `시스템` loses another. A test asserting uniform doubling would assert
    // something this evidence contradicts.
    const nonUniform = RECORDED_OUTPUT.flatMap(({ clean, corrupted }) => {
      const corruptedRuns = segmentByRendererRiskClass(corrupted)
      return segmentByRendererRiskClass(clean)
        .map((run, index) => ({ run, after: corruptedRuns[index]?.text ?? '' }))
        .filter(({ run, after }) => run.risky && after.length !== run.text.length * 2)
    })

    expect(nonUniform.map(({ run }) => run.text)).toEqual(['자바스크립트', '시스템'])
    expect(nonUniform.map(({ after }) => after)).toEqual(['자자바바스크크립립트트', '시시스템템'])
  })
})

describe('#6890 as the discriminating mutation', () => {
  const riskyRuns = (): { risky: boolean; text: string }[] =>
    RECORDED_OUTPUT.flatMap(({ clean }) =>
      segmentByRendererRiskClass(clean).filter((run) => run.risky)
    )

  it('elects a repaint for every corrupted run when the agent types nothing', () => {
    const refreshed = riskyRuns().filter((run) =>
      windowsEastAsianOutputPrefersRenderRefresh(run.text, UNTYPED_AGENT_OUTPUT)
    )
    expect(refreshed).toHaveLength(17)
  })

  it('elects none of them once #6890 is reverted', () => {
    const refreshed = riskyRuns().filter((run) =>
      pre6890PrefersRenderRefresh(run.text, UNTYPED_AGENT_OUTPUT)
    )
    // 17 -> 0. Untyped wide-glyph output was never repainted before #6890, which is the
    // condition #12164 comment 1 reports and the only condition the two arms disagree on.
    expect(refreshed).toHaveLength(0)
  })

  it('agrees with the reverted predicate whenever the user has recently typed', () => {
    for (const run of riskyRuns()) {
      expect(windowsEastAsianOutputPrefersRenderRefresh(run.text, TYPED_INPUT_ECHO)).toBe(
        pre6890PrefersRenderRefresh(run.text, TYPED_INPUT_ECHO)
      )
    }
    const refreshed = riskyRuns().filter((run) =>
      pre6890PrefersRenderRefresh(run.text, TYPED_INPUT_ECHO)
    )
    expect(refreshed).toHaveLength(17)
  })
})
