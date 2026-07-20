// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MissionCreateMemberStatusList,
  type MissionCreateMemberStatus
} from './MissionCreateMemberStatusList'

let root: Root | null = null

function renderStatusList(entries: MissionCreateMemberStatus[]): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<MissionCreateMemberStatusList entries={entries} />)
  })
  return container
}

describe('MissionCreateMemberStatusList', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('renders pending members while the fan-out runs', () => {
    const container = renderStatusList([
      { repoId: 'r1', repoName: 'backend', state: 'pending' },
      { repoId: 'r2', repoName: 'docs', state: 'pending' }
    ])
    expect(container.textContent).toContain('backend')
    expect(container.textContent).toContain('docs')
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(2)
  })

  it('surfaces per-member failures inline with their error text', () => {
    const container = renderStatusList([
      { repoId: 'r1', repoName: 'backend', state: 'created' },
      {
        repoId: 'r2',
        repoName: 'docs',
        state: 'failed',
        error: 'Branch "mission/referral" already exists locally.'
      }
    ])
    expect(container.textContent).toContain('backend')
    expect(container.textContent).toContain('docs')
    expect(container.textContent).toContain('already exists locally')
    expect(container.querySelectorAll('.text-destructive').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(0)
  })
})
