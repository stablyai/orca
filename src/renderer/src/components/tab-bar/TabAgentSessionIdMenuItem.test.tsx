/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabAgentSessionIdMenuItem } from './TabAgentSessionIdMenuItem'

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    'aria-label': ariaLabel
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
    'aria-label'?: string
  }) => (
    <button type="button" disabled={disabled} aria-label={ariaLabel} onClick={() => onSelect?.()}>
      {children}
    </button>
  )
}))

vi.mock('lucide-react', () => ({ Copy: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: toastMock }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function render(sessionId: string | null): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<TabAgentSessionIdMenuItem sessionId={sessionId} />))
  mounted.push({ container, root })
  return container
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

describe('TabAgentSessionIdMenuItem', () => {
  it('renders nothing when no session id is available', () => {
    expect(render(null).textContent).toBe('')
  })

  it('copies on select when an id is known', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    const container = render('abc-123')

    const button = container.querySelector('button')
    expect(button?.disabled).toBe(false)
    act(() => button?.click())
    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('abc-123'))
  })

  it('reports clipboard failures', async () => {
    const writeClipboardText = vi.fn().mockRejectedValue(new Error('clipboard unavailable'))
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    const button = render('abc-123').querySelector('button')

    act(() => button?.click())
    await vi.waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Failed to copy Session ID')
    )
  })
})
