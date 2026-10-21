/** @vitest-environment happy-dom */
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { CopyTabIdMenuItem } from './CopyTabIdMenuItem'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect: () => void
  }) => <button onClick={onSelect}>{children}</button>
}))

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  vi.clearAllMocks()
  writeClipboardText.mockResolvedValue(undefined)
  vi.stubGlobal('api', { ui: { writeClipboardText } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CopyTabIdMenuItem', () => {
  it('copies the labeled workspace ID and confirms only after the write succeeds', async () => {
    let finishWrite: (() => void) | undefined
    writeClipboardText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    render(<CopyTabIdMenuItem unifiedTabId="workspace-tab-123" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Tab ID' }))
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('orcaTabId: workspace-tab-123')
    expect(toast.success).not.toHaveBeenCalled()
    await act(async () => finishWrite?.())
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Tab ID copied')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports a failed write without exposing native error details or claiming success', async () => {
    writeClipboardText.mockRejectedValue(new Error('private native clipboard details'))
    render(<CopyTabIdMenuItem unifiedTabId="workspace-tab-123" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Tab ID' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not copy tab ID')
    )
    expect(toast.success).not.toHaveBeenCalled()
  })
})
