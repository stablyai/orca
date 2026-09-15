// @vitest-environment happy-dom

import type React from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'

const capturedRestoreSignals: (string | undefined)[] = []

vi.mock('@/hooks/useVirtualizedScrollAnchor', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useVirtualizedScrollAnchor: (options: { restoreSignal?: string }) => {
      capturedRestoreSignals.push(options.restoreSignal)
    }
  }
})

const { createProgrammaticScrollMarks } = await import('@/hooks/programmatic-scroll-marks')
const { useCombinedDiffScrollAnchors } = await import('./use-combined-diff-scroll-anchors')
const { useCombinedDiffSectionRowKeys } =
  await import('../resolve-changes/use-combined-diff-section-row-keys')
const { createCombinedDiffSectionIndexMap } =
  await import('../resolve-changes/combined-diff-section-identity')

/** The signal this PR replaces: one template string per section, joined, on every section load. */
function legacyRestoreSignal(args: {
  clampRestoreCount: number
  generation: number
  sections: readonly DiffSection[]
  sideBySide: boolean
}): string {
  return `${args.generation}|${args.sideBySide ? 'sbs' : 'inline'}|${args.clampRestoreCount}|${args.sections
    .map(
      (section) =>
        `${section.key}:${section.collapsed ? 'c' : 'e'}:${section.contentGeneration ?? 0}`
    )
    .join(',')}`
}

function section(key: string, overrides: Partial<DiffSection> = {}): DiffSection {
  return {
    key,
    path: key,
    status: 'modified',
    originalContent: '',
    modifiedContent: '',
    collapsed: false,
    loading: true,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null,
    ...overrides
  }
}

type Step = {
  clampRestoreCount: number
  generation: number
  sections: DiffSection[]
  sideBySide: boolean
}

function changePoints(signals: readonly (string | undefined)[]): number[] {
  const points: number[] = []
  for (let index = 1; index < signals.length; index += 1) {
    if (signals[index] !== signals[index - 1]) {
      points.push(index)
    }
  }
  return points
}

function renderSignals(steps: readonly Step[]): (string | undefined)[] {
  capturedRestoreSignals.length = 0
  const sectionsRef = { current: steps[0]!.sections } as React.RefObject<DiffSection[]>
  const view = renderHook(
    (step: Step) => {
      sectionsRef.current = step.sections
      const rowKeys = useCombinedDiffSectionRowKeys({
        generation: step.generation,
        sections: step.sections
      })
      useCombinedDiffScrollAnchors({
        clampRestoreCount: step.clampRestoreCount,
        generation: step.generation,
        hasDirectScrollInput: () => false,
        latestDomScrollAnchorRef: { current: null } as React.RefObject<VirtualizedScrollAnchor>,
        programmaticScrollMarks: createProgrammaticScrollMarks(),
        scrollAnchorRef: { current: null } as React.RefObject<VirtualizedScrollAnchor>,
        scrollContainerRef: { current: null } as React.RefObject<HTMLDivElement | null>,
        scrollOffsetRef: { current: 0 } as React.RefObject<number>,
        sectionIndexByKey: createCombinedDiffSectionIndexMap(step.sections),
        sections: step.sections,
        sectionsRef,
        sideBySide: step.sideBySide,
        structureRevision: rowKeys.structureRevision,
        totalSize: 0,
        viewStateKey: 'equivalence-test',
        virtualizer: {
          getVirtualItems: () => [],
          isScrolling: false,
          scrollToIndex: vi.fn()
        } as unknown as Virtualizer<HTMLDivElement, Element>
      })
    },
    { initialProps: steps[0]! }
  )
  // Only the render-phase signal matters; drop React's duplicate renders of the same props.
  const perStep: (string | undefined)[] = [capturedRestoreSignals.at(-1)]
  for (const step of steps.slice(1)) {
    capturedRestoreSignals.length = 0
    view.rerender(step)
    perStep.push(capturedRestoreSignals.at(-1))
  }
  return perStep
}

describe('combined diff restore signal', () => {
  it('changes at exactly the same points as the per-section join it replaces', () => {
    const base = [
      section('a.ts'),
      section('b.ts'),
      section('c.ts'),
      section('d.ts'),
      section('e.ts')
    ]
    const loadedC = base.slice()
    loadedC[2] = section('c.ts', { loading: false })
    const collapsedB = loadedC.slice()
    collapsedB[1] = section('b.ts', { collapsed: true })
    const reloadedC = collapsedB.slice()
    reloadedC[2] = section('c.ts', { loading: false, contentGeneration: 1 })
    const reordered = [reloadedC[0]!, reloadedC[2]!, reloadedC[1]!, reloadedC[3]!, reloadedC[4]!]
    const removed = reordered.slice(0, 4)

    const steps: Step[] = [
      { clampRestoreCount: 0, generation: 1, sections: base, sideBySide: false },
      // A section load.
      { clampRestoreCount: 0, generation: 1, sections: loadedC, sideBySide: false },
      // A no-op commit: fresh array, identical elements.
      { clampRestoreCount: 0, generation: 1, sections: loadedC.slice(), sideBySide: false },
      // A collapse toggle.
      { clampRestoreCount: 0, generation: 1, sections: collapsedB, sideBySide: false },
      // A refetch that really changed content (contentGeneration bump).
      { clampRestoreCount: 0, generation: 1, sections: reloadedC, sideBySide: false },
      // A reorder that keeps every key.
      { clampRestoreCount: 0, generation: 1, sections: reordered, sideBySide: false },
      // A removal.
      { clampRestoreCount: 0, generation: 1, sections: removed, sideBySide: false },
      // Inline -> side-by-side.
      { clampRestoreCount: 0, generation: 1, sections: removed, sideBySide: true },
      // A browser clamp re-pin.
      { clampRestoreCount: 1, generation: 1, sections: removed, sideBySide: true },
      // A full entry-set rebuild.
      { clampRestoreCount: 1, generation: 2, sections: removed, sideBySide: true }
    ]

    const legacy = steps.map((step) => legacyRestoreSignal(step))
    expect(changePoints(renderSignals(steps))).toEqual(changePoints(legacy))
  })

  it('holds the signal steady through a 500-section progressive load and lands on the same rows', () => {
    const count = 500
    let sections = Array.from({ length: count }, (_, index) => section(`file-${index}.ts`))
    const steps: Step[] = [{ clampRestoreCount: 0, generation: 1, sections, sideBySide: false }]
    for (let index = 0; index < count; index += 1) {
      const next = sections.slice()
      next[index] = section(`file-${index}.ts`, { loading: false })
      sections = next
      steps.push({ clampRestoreCount: 0, generation: 1, sections, sideBySide: false })
    }

    const legacy = steps.map((step) => legacyRestoreSignal(step))
    expect(changePoints(renderSignals(steps))).toEqual(changePoints(legacy))
    // Every anchor key still resolves to the index a freshly built map would give it.
    expect([...createCombinedDiffSectionIndexMap(sections)]).toEqual([
      ...createCombinedDiffSectionIndexMap(steps.at(-1)!.sections)
    ])
  })
})
