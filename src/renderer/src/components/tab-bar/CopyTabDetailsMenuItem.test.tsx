/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { CopyTabDetailsMenuItem } from './CopyTabDetailsMenuItem'

const mocks = vi.hoisted(() => ({ describe: vi.fn(), write: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./workspace-tab-location', () => ({ describeTabLocation: mocks.describe }))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect: () => void
  }) => <button onClick={onSelect}>{children}</button>
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Copy Tab Details', () => {
  it('copies the clicked tab’s current location as JSON', async () => {
    const details = {
      schemaVersion: 1,
      application: 'Orca',
      tabs: [{ tabId: 'inactive-tab', groupId: 'g2', position: 2 }]
    }
    mocks.describe.mockReturnValue(details)
    mocks.write.mockResolvedValue(undefined)
    vi.stubGlobal('api', { ui: { writeClipboardText: mocks.write } })
    render(<CopyTabDetailsMenuItem unifiedTabId="inactive-tab" groupId="g2" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Tab Details' }))
    expect(mocks.describe).toHaveBeenCalledWith('inactive-tab', 'g2')
    expect(JSON.parse(mocks.write.mock.calls[0][0])).toEqual(details)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Tab details copied'))
  })

  it('reports an unavailable tab without copying stale details', async () => {
    mocks.describe.mockImplementation(() => {
      throw new Error('tab_not_found')
    })
    vi.stubGlobal('api', { ui: { writeClipboardText: mocks.write } })
    render(<CopyTabDetailsMenuItem unifiedTabId="closed-tab" groupId="g2" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Tab Details' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy tab details'))
    expect(mocks.write).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
