/** @vitest-environment happy-dom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'

const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: React.ReactNode }) => children
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: passthrough,
  DropdownMenuSubTrigger: passthrough,
  DropdownMenuSubContent: passthrough
}))

const initialState = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('SidebarRepositoryFilterSection hidden projects', () => {
  it('lists hidden projects only where the view still shows their work (Agents)', () => {
    useAppStore.setState({
      repos: [
        { ...TEST_REPO, id: 'a', displayName: 'listed-a' },
        { ...TEST_REPO, id: 'b', displayName: 'listed-b' },
        { ...TEST_REPO, id: 'h', displayName: 'hidden-h', hiddenAt: 1 }
      ]
    })
    const agents = { filterRepoIds: [], setFilterRepoIds: vi.fn() }

    render(<SidebarRepositoryFilterSection />)
    expect(screen.getByText('listed-a')).toBeTruthy()
    expect(screen.queryByText('hidden-h')).toBeNull()
    cleanup()

    render(<SidebarRepositoryFilterSection {...agents} includeHidden />)
    expect(screen.getByText('hidden-h')).toBeTruthy()
  })
})
