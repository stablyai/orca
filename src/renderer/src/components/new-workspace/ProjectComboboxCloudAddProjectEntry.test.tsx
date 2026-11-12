// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { withCloudAddProjectEntry } from './ProjectComboboxCloudAddProjectEntry'

afterEach(cleanup)

const menu = {
  defaultHostId: null,
  onOpenEntryRequest: vi.fn(),
  onOpenRemoteHostDialog: vi.fn()
}

describe('withCloudAddProjectEntry (PROJ-MENU part 2)', () => {
  it('moves the access link into the Add project menu and out of the list', () => {
    const more = vi.fn()
    const closeMenus = vi.fn()
    const result = withCloudAddProjectEntry(menu, more)
    expect(result.listMoreAccess).toBeUndefined()
    render(
      <DropdownMenu open>
        <DropdownMenuContent>{result.addProjectMenu?.extraItems?.(closeMenus)}</DropdownMenuContent>
      </DropdownMenu>
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'From GitHub (Orca Cloud)…' }))
    expect(closeMenus).toHaveBeenCalledOnce()
    expect(more).toHaveBeenCalledOnce()
    expect(closeMenus.mock.invocationCallOrder[0]).toBeLessThan(more.mock.invocationCallOrder[0])
  })

  it('keeps the list row when there is no Add project menu, and adds nothing without Orca Cloud', () => {
    const more = vi.fn()
    expect(withCloudAddProjectEntry(undefined, more)).toEqual({
      addProjectMenu: undefined,
      listMoreAccess: more
    })
    expect(withCloudAddProjectEntry(menu, undefined)).toEqual({
      addProjectMenu: menu,
      listMoreAccess: undefined
    })
  })
})
