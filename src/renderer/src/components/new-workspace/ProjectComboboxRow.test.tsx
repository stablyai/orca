// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MatchedText } from './ProjectComboboxRow'
import { rankProjectOptions } from './project-combobox-matching'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function markedText(): string {
  return Array.from(container.querySelectorAll('mark'))
    .map((mark) => mark.textContent ?? '')
    .join('')
}

describe('MatchedText', () => {
  // UTF-16 hit offsets and code-point rendering differ for emoji; marks must stay on the matched glyphs.
  it('aligns marks with the query when the name starts with an emoji', () => {
    const option: NewWorkspaceProjectOption = {
      kind: 'project',
      id: 'p1',
      projectId: 'p1',
      displayName: '🚀 orca',
      badgeColor: '#111111',
      detail: '~/dev/orca'
    }
    const [match] = rankProjectOptions([option], 'orca', [])
    expect(match).toBeDefined()

    act(() => {
      root.render(<MatchedText text={option.displayName} hits={match!.nameHits} />)
    })

    expect(markedText()).toBe('orca')
  })
})
