// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SkillCloudOwnedShare } from '../../../../shared/skill-cloud-contract'
import { SkillSharedLinkRow } from './SkillSharedLinkRow'

const share: SkillCloudOwnedShare = {
  id: 'shr_1',
  url: 'https://share.onorca.dev/skills/share/shr_1',
  packageId: 'pkg_1',
  name: 'agent-discord-and-1-more',
  description: 'Team skills',
  createdAt: '2026-08-12T00:00:00.000Z'
}

/** Radix opens its menu on pointerdown, which fireEvent.click does not send. */
async function openDeleteMenu(): Promise<void> {
  fireEvent.pointerDown(
    screen.getByRole('button', { name: /More actions/ }),
    new PointerEvent('pointerdown', { bubbles: true, button: 0 })
  )
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete from the Cloud' }))
}

function renderRow(onDeleted = vi.fn()): { onDeleted: ReturnType<typeof vi.fn> } {
  render(
    <TooltipProvider>
      <ul>
        <SkillSharedLinkRow
          share={share}
          busy={false}
          onRevoke={() => undefined}
          onDeleted={onDeleted}
        />
      </ul>
    </TooltipProvider>
  )
  return { onDeleted }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('SkillSharedLinkRow', () => {
  it('deletes the published package only after a confirmation', async () => {
    const deletePackage = vi.fn().mockResolvedValue({ status: 'ok', value: undefined })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { deletePackage }, ui: { writeClipboardText: vi.fn() } }
    })
    const { onDeleted } = renderRow()

    await openDeleteMenu()
    expect(deletePackage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))

    expect(deletePackage).toHaveBeenCalledWith('pkg_1')
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
  })

  it('keeps the row when the Cloud rejects the deletion', async () => {
    const deletePackage = vi
      .fn()
      .mockResolvedValue({ status: 'unsupported', message: 'Deletion is unavailable.' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { deletePackage }, ui: { writeClipboardText: vi.fn() } }
    })
    const { onDeleted } = renderRow()

    await openDeleteMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))

    await vi.waitFor(() => expect(deletePackage).toHaveBeenCalledOnce())
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
