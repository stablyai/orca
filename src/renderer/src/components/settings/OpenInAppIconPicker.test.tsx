// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenInAppIconPicker } from './OpenInAppIconPicker'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const { pickOpenInAppIconMock, toastErrorMock } = vi.hoisted(() => ({
  pickOpenInAppIconMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

beforeEach(() => {
  pickOpenInAppIconMock.mockReset()
  toastErrorMock.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { shell: { pickOpenInAppIcon: pickOpenInAppIconMock } }
  })
})

afterEach(cleanup)

describe('OpenInAppIconPicker', () => {
  it('reports the bundled icon a user picks', () => {
    const onSelect = vi.fn()
    render(<OpenInAppIconPicker application={{ command: 'idea' }} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: 'Use Braces icon' }))

    expect(onSelect).toHaveBeenCalledWith({ type: 'bundled', id: 'Braces' })
  })

  it('stores the icon extracted from an app the user chooses', async () => {
    const onSelect = vi.fn()
    pickOpenInAppIconMock.mockResolvedValue({
      dataUrl: 'data:image/png;base64,aGk=',
      label: 'IntelliJ IDEA'
    })
    render(<OpenInAppIconPicker application={{ command: 'idea' }} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: "Use an installed app's icon…" }))

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith({
        type: 'image',
        src: 'data:image/png;base64,aGk='
      })
    )
  })

  it('leaves the icon alone when the file dialog is cancelled', async () => {
    const onSelect = vi.fn()
    pickOpenInAppIconMock.mockResolvedValue(null)
    render(<OpenInAppIconPicker application={{ command: 'idea' }} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: "Use an installed app's icon…" }))

    await waitFor(() => expect(pickOpenInAppIconMock).toHaveBeenCalled())
    expect(onSelect).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('surfaces an extraction failure instead of silently keeping the old icon', async () => {
    const onSelect = vi.fn()
    pickOpenInAppIconMock.mockRejectedValue(new Error('Could not read an icon.'))
    render(<OpenInAppIconPicker application={{ command: 'idea' }} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: "Use an installed app's icon…" }))

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith('Could not read that application icon.', {
        description: 'Could not read an icon.'
      })
    )
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('offers reset only once a row has its own icon', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <OpenInAppIconPicker application={{ command: 'idea' }} onSelect={onSelect} />
    )

    const reset = screen.getByRole('button', { name: 'Use default icon' }) as HTMLButtonElement
    expect(reset.disabled).toBe(true)

    rerender(
      <OpenInAppIconPicker
        application={{ command: 'idea', icon: { type: 'bundled', id: 'Braces' } }}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use default icon' }))

    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('marks the icon a row already uses as pressed', () => {
    render(
      <OpenInAppIconPicker
        application={{ command: 'idea', icon: { type: 'bundled', id: 'Braces' } }}
        onSelect={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Use Braces icon' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Use Terminal icon' }).getAttribute('aria-pressed')
    ).toBe('false')
  })
})
