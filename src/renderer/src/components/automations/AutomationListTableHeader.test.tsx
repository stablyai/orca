// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationListTableHeader } from './AutomationListTableHeader'
import {
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_STICKY_HEADER_CELL_CLASS
} from '@/lib/list-table-layout'

describe('AutomationListTableHeader', () => {
  afterEach(cleanup)

  it('renders all expected columns', () => {
    render(<AutomationListTableHeader />)

    expect(screen.getByText('Name')).toBeDefined()
    expect(screen.getByText('Schedule')).toBeDefined()
    expect(screen.getByText('Project')).toBeDefined()
    expect(screen.getByText('Host')).toBeDefined()
    expect(screen.getByText('Next run')).toBeDefined()
    expect(screen.getByText('Last run')).toBeDefined()
    expect(screen.getByText('Status')).toBeDefined()
    expect(screen.getByText('Agent')).toBeDefined()
    expect(screen.getByText('Actions')).toBeDefined()
  })

  it('uses opaque background and sticky positioning on the header row', () => {
    const { container } = render(<AutomationListTableHeader />)
    const header = container.firstElementChild as HTMLElement

    expect(header.className).toContain(LIST_TABLE_HEADER_CLASS)
    expect(header.className).toContain('sticky')
    expect(header.className).toContain('top-0')
    expect(header.className).toContain('bg-[color-mix(in_srgb,var(--muted)_40%,var(--background))]')
    expect(header.className).not.toContain('bg-muted/25')
  })

  it('applies sticky cell styling to the first column', () => {
    render(<AutomationListTableHeader />)
    const nameCell = screen.getByText('Name')

    expect(nameCell.className).toBe(LIST_TABLE_STICKY_HEADER_CELL_CLASS)
  })
})
