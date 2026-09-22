// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/SelectedTextCopyMenu', () => ({
  SelectedTextCopyMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('./ports-status-popover-rows', () => ({
  PortRow: () => <div />,
  WorkspaceGroupRows: () => <div />
}))

vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    options
      ? fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? ''))
      : fallback
}))

import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import { useAppStore } from '@/store'
import { PortsStatusSegment } from './PortsStatusSegment'

describe('PortsStatusSegment render stability', () => {
  let container: HTMLDivElement
  let root: Root
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    consoleError.mockRestore()
  })

  it('keeps the status controls mounted when the runtime owner is local', () => {
    act(() => {
      root.render(
        <RecoverableRenderErrorBoundary
          boundaryId="oracle.status-bar"
          surface="overlay"
          compact
          reportAsCrash={false}
          title="The status bar hit an error."
          description="Retry the status bar to remount its controls."
        >
          <PortsStatusSegment iconOnly={false} />
        </RecoverableRenderErrorBoundary>
      )
    })

    const underlyingException = consoleError.mock.calls.find(
      ([message, error]) =>
        message === '[oracle.status-bar] render crash contained by boundary' &&
        error instanceof Error &&
        error.message.includes('Maximum update depth exceeded')
    )

    expect.soft(container.textContent).not.toContain('The status bar hit an error.')
    expect.soft(underlyingException).toBeUndefined()
    expect(container.querySelector('button[aria-label^="Ports, 0 workspace"]')).not.toBeNull()
  })
})
