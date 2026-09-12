// @vitest-environment happy-dom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SectionHeader } from './section-header'

describe('SectionHeader', () => {
  it('renders section label and file count without wrapping classes', () => {
    const { container } = render(
      <SectionHeader
        label="Changes"
        count={13}
        isCollapsed={false}
        onToggle={vi.fn()}
        actions={<button type="button">Action</button>}
      />
    )

    expect(screen.getByText('Changes')).toBeDefined()
    expect(screen.getByText('13')).toBeDefined()
    expect(screen.getByRole('button', { name: /Changes/i })).toBeDefined()

    // Ensure flex-wrap is not used on container or action clusters
    const sectionRow = container.querySelector('.group\\/section')
    expect(sectionRow).not.toBeNull()
    expect(sectionRow?.className).not.toContain('flex-wrap')
    expect(sectionRow?.className).toContain('flex')

    // Ensure actions container does not wrap and has shrink-0
    const actionsContainer = sectionRow?.lastElementChild
    expect(actionsContainer?.className).toContain('shrink-0')
    expect(actionsContainer?.className).not.toContain('flex-wrap')

    // Ensure label has truncate to prevent overflowing row on narrow widths
    const labelSpan = screen.getByText('Changes')
    expect(labelSpan.className).toContain('truncate')
  })

  it('calls onToggle when header button is clicked', () => {
    const onToggle = vi.fn()
    render(
      <SectionHeader label="Staged Changes" count={5} isCollapsed={true} onToggle={onToggle} />
    )

    fireEvent.click(screen.getByRole('button', { name: /Staged Changes/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('keeps View all text button and icon actions together without wrapping', () => {
    render(
      <SectionHeader
        label="Changes"
        count={13}
        isCollapsed={false}
        onToggle={vi.fn()}
        actions={
          <div className="flex shrink-0 items-center">
            <button type="button" aria-label="Discard all">
              Discard
            </button>
            <button type="button" aria-label="Stage all">
              Stage
            </button>
            <button type="button" className="shrink-0 whitespace-nowrap">
              View all
            </button>
          </div>
        }
      />
    )

    expect(screen.getByText('View all')).toBeDefined()
    expect(screen.getByLabelText('Discard all')).toBeDefined()
    expect(screen.getByLabelText('Stage all')).toBeDefined()
  })
})
