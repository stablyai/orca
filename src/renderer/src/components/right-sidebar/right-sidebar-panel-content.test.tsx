// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'

vi.mock('./WorkspaceNotesPanel', () => ({
  default: () => <h1>Notes</h1>
}))

describe('RightSidebarPanelContent', () => {
  it('renders the built-in Notes panel for the notes route', async () => {
    render(<RightSidebarPanelContent effectiveTab="notes" rightSidebarOpen />)

    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeTruthy()
  })
})
