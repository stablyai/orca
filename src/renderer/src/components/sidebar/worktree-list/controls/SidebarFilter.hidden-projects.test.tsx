/** @vitest-environment happy-dom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import SidebarFilter from './SidebarFilter'

const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: React.ReactNode }) => children
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: passthrough,
  DropdownMenuContent: passthrough,
  DropdownMenuTrigger: passthrough,
  DropdownMenuSeparator: () => null
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: passthrough,
  TooltipTrigger: passthrough,
  TooltipContent: () => null
}))

const initialState = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('SidebarFilter project list', () => {
  it('leaves hidden projects out of the board’s project filter', () => {
    useAppStore.setState({
      repos: [
        { ...TEST_REPO, id: 'a', displayName: 'listed-a' },
        { ...TEST_REPO, id: 'b', displayName: 'listed-b' },
        { ...TEST_REPO, id: 'h', displayName: 'hidden-h', hiddenAt: 1 }
      ]
    })

    render(<SidebarFilter />)

    expect(screen.getByText('listed-a')).toBeTruthy()
    expect(screen.getByText('listed-b')).toBeTruthy()
    expect(screen.queryByText('hidden-h')).toBeNull()
  })
})
