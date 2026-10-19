// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraProjectPicker } from './jira-project-picker'

afterEach(cleanup)
const alpha = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a', siteName: 'First site' }
const otherSite = { ...alpha, siteId: 'site-b', siteName: 'Second site' }

describe('Jira project picker', () => {
  it('distinguishes projects with the same id on different sites and closes after selection', async () => {
    const onChange = vi.fn()
    render(
      <JiraProjectPicker
        projects={[alpha, otherSite]}
        value={alpha}
        onChange={onChange}
        label="Jira project"
        emptyLabel="All Jira projects"
      />
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Jira project' }))
    fireEvent.click(await screen.findByRole('option', { name: /Second site/ }))
    expect(onChange).toHaveBeenCalledWith({ id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-b' })
    await waitFor(() => expect(screen.queryByRole('option')).toBeNull())
  })

  it('lets the user clear a repository default to search all projects', async () => {
    const onChange = vi.fn()
    render(
      <JiraProjectPicker
        projects={[alpha]}
        value={alpha}
        onChange={onChange}
        label="Jira project"
        emptyLabel="All Jira projects"
      />
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Jira project' }))
    fireEvent.click(await screen.findByRole('option', { name: 'All Jira projects' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
