// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import type { StoppedWslHost } from '../wsl-host-stopped/use-stopped-wsl-host'
import { WorktreeWslHostStartMenuItem } from './WorktreeWslHostStartMenuItem'

const mocks = vi.hoisted(() => {
  const stopped: { current: StoppedWslHost | null } = { current: null }
  return {
    stopped,
    start: vi.fn<(environmentId: string) => Promise<boolean>>()
  }
})

vi.mock('../wsl-host-stopped/use-stopped-wsl-host', () => ({
  useStoppedWslHost: () => mocks.stopped.current
}))
vi.mock('@/lib/wsl-host-user-start', () => ({
  startWslHostAndReloadProjects: mocks.start
}))

function renderMenu() {
  return render(
    <DropdownMenu open modal={false}>
      <DropdownMenuContent>
        <WorktreeWslHostStartMenuItem worktreeId="wt-wsl" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

afterEach(() => {
  cleanup()
  mocks.stopped.current = null
  mocks.start.mockReset()
})

describe('WorktreeWslHostStartMenuItem', () => {
  it('offers Start for a workspace on a stopped distro, and boots only on select (E9)', () => {
    mocks.stopped.current = { environmentId: 'wsl:ubuntu', distro: 'Ubuntu' }
    mocks.start.mockResolvedValue(true)
    const view = renderMenu()
    expect(mocks.start).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('menuitem', { name: 'Start Ubuntu' }))
    expect(mocks.start).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('adds nothing for a workspace whose host is not stopped', () => {
    const view = renderMenu()
    expect(view.queryByRole('menuitem')).toBeNull()
  })
})
