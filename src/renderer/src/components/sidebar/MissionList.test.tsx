// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission } from '../../../../shared/types'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/store-test-helpers'
import MissionList from './MissionList'

let root: Root | null = null

function renderMissionList(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<MissionList />)
  })
  return container
}

describe('MissionList', () => {
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

  it('shows the empty state without missions', () => {
    act(() => {
      ;(useAppStore as unknown as { setState: (s: object) => void }).setState({
        repos: [TEST_REPO],
        missions: []
      })
    })
    const container = renderMissionList()
    expect(container.textContent).toContain('No missions yet')
    expect(container.textContent).toContain('New Mission')
  })

  it('renders a mission header with member count and a recreate row for missing worktrees', () => {
    const mission: Mission = {
      id: 'm1',
      name: 'Referral',
      branchName: 'mission/referral',
      members: [{ repoId: TEST_REPO.id, worktreeId: null, addedAt: 1 }],
      tabOrder: 0,
      createdAt: 1,
      updatedAt: 1
    }
    act(() => {
      ;(useAppStore as unknown as { setState: (s: object) => void }).setState({
        repos: [TEST_REPO],
        missions: [mission]
      })
    })
    const container = renderMissionList()
    expect(container.textContent).toContain('Referral')
    expect(container.textContent).toContain('1 projects')
    expect(container.textContent).toContain(TEST_REPO.displayName)
    expect(container.textContent).toContain('Workspace missing')
  })
})
