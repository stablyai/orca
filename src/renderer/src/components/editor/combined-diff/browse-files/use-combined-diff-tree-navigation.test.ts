// @vitest-environment happy-dom

import React from 'react'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffTreeNavigation } from './use-combined-diff-tree-navigation'

function makeSection(key: string, viewed: boolean): DiffSection {
  return {
    key,
    path: key,
    status: 'modified',
    originalContent: '',
    modifiedContent: '',
    collapsed: false,
    loading: !viewed,
    loadOnDemand: !viewed,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null
  }
}

function renderNavigation(sections: DiffSection[], entrySignature: string) {
  const sectionsRef = { current: sections } as React.RefObject<DiffSection[]>
  return renderHook(
    (props: { sections: DiffSection[]; entrySignature: string }) => {
      sectionsRef.current = props.sections
      return useCombinedDiffTreeNavigation({
        ensureSectionLoaded: vi.fn(),
        entrySignature: props.entrySignature,
        markDirectScrollInput: vi.fn(),
        scrollToIndex: vi.fn(),
        sectionIndexByKey: new Map(props.sections.map((section, index) => [section.key, index])),
        sections: props.sections,
        sectionsRef,
        toggleSection: vi.fn(),
        treeMode: 'all'
      })
    },
    { initialProps: { sections, entrySignature } }
  )
}

describe('useCombinedDiffTreeNavigation viewedSectionKeys', () => {
  it('keeps every viewed key when sections are reordered under one entry signature', () => {
    const a = makeSection('a', true)
    const b = makeSection('b', true)
    const view = renderNavigation([a, b], 'sig')
    expect([...view.result.current.viewedSectionKeys].sort()).toEqual(['a', 'b'])

    view.rerender({ sections: [b, a], entrySignature: 'sig' })
    expect([...view.result.current.viewedSectionKeys].sort()).toEqual(['a', 'b'])
  })

  it('patches only the flipped section while keys stay in place', () => {
    const a = makeSection('a', true)
    const view = renderNavigation([a, makeSection('b', false)], 'sig')
    expect([...view.result.current.viewedSectionKeys]).toEqual(['a'])

    view.rerender({ sections: [a, makeSection('b', true)], entrySignature: 'sig' })
    expect([...view.result.current.viewedSectionKeys].sort()).toEqual(['a', 'b'])
  })

  it('reuses the cached set when no section changed viewed state', () => {
    const sections = [makeSection('a', true), makeSection('b', false)]
    const view = renderNavigation(sections, 'sig')
    const first = view.result.current.viewedSectionKeys

    view.rerender({ sections: [...sections], entrySignature: 'sig' })
    expect(view.result.current.viewedSectionKeys).toBe(first)
  })
})
