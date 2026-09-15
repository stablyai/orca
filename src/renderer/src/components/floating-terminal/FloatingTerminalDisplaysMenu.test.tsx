/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FloatingTerminalDisplaysMenu } from './FloatingTerminalDisplaysMenu'
import type { WorkspaceDisplayInfo } from '../../../../shared/floating-workspace-display'

const mockDisplays: WorkspaceDisplayInfo[] = [
  {
    id: 1,
    label: 'Built-in Display',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    isPrimary: true
  },
  {
    id: 2,
    label: 'External Monitor',
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    isPrimary: false
  }
]

describe('FloatingTerminalDisplaysMenu', () => {
  afterEach(() => {
    cleanup()
  })

  it('does not immediately call onMoveToNextDisplay when opening the menu', () => {
    const onMoveToDisplay = vi.fn()
    const onMoveToNextDisplay = vi.fn()
    const onRefreshDisplays = vi.fn()

    render(
      <TooltipProvider>
        <FloatingTerminalDisplaysMenu
          displays={mockDisplays}
          currentDisplayId={1}
          isDetached={true}
          controlButtonClassName="test-btn"
          onMoveToDisplay={onMoveToDisplay}
          onMoveToNextDisplay={onMoveToNextDisplay}
          onRefreshDisplays={onRefreshDisplays}
        />
      </TooltipProvider>
    )

    const triggerButton = screen.getByRole('button')
    fireEvent.pointerDown(triggerButton, { button: 0 })
    fireEvent.click(triggerButton)

    // Opening the menu should refresh displays, but NOT move to next display
    expect(onRefreshDisplays).toHaveBeenCalled()
    expect(onMoveToNextDisplay).not.toHaveBeenCalled()
    expect(onMoveToDisplay).not.toHaveBeenCalled()
  })

  it('renders nothing when displays list is empty', () => {
    const { container } = render(
      <FloatingTerminalDisplaysMenu
        displays={[]}
        currentDisplayId={null}
        isDetached={false}
        controlButtonClassName="test-btn"
        onMoveToNextDisplay={vi.fn()}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('badges the primary display so an OS label cannot hide which screen it is', async () => {
    render(
      <TooltipProvider>
        <FloatingTerminalDisplaysMenu
          displays={mockDisplays}
          currentDisplayId={1}
          isDetached={true}
          controlButtonClassName="test-btn"
          onMoveToDisplay={vi.fn()}
          onMoveToNextDisplay={vi.fn()}
        />
      </TooltipProvider>
    )

    const triggerButton = screen.getByRole('button')
    fireEvent.pointerDown(triggerButton, { button: 0 })
    fireEvent.click(triggerButton)

    expect(await screen.findByText('Primary')).toBeTruthy()
    expect(screen.getAllByText('Primary')).toHaveLength(1)
  })
})
