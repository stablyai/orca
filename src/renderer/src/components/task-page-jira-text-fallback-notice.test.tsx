// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskPageJiraTextFallbackNotice } from './task-page-jira-text-fallback-notice'

afterEach(cleanup)

const REASON = "Field 'login' does not exist or you do not have permission to view it."
const PROSE = { reason: REASON, likelyTypo: false }

describe('TaskPageJiraTextFallbackNotice', () => {
  it("keeps Jira's reason behind Details", () => {
    render(<TaskPageJiraTextFallbackNotice rejection={PROSE} />)
    expect(screen.getByText(/Showing text matches/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Showing text matches')
    expect(screen.queryByText(REASON)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText(REASON)).toBeTruthy()
  })

  it("shows Jira's reason straight away for a likely JQL typo", () => {
    render(<TaskPageJiraTextFallbackNotice rejection={{ reason: REASON, likelyTypo: true }} />)
    expect(screen.getByText(REASON)).toBeTruthy()
  })

  it('omits Details when Jira gave no reason', () => {
    render(<TaskPageJiraTextFallbackNotice rejection={{ reason: '', likelyTypo: true }} />)
    expect(screen.getByText(/Showing text matches/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('updates one mounted live region instead of inserting a new one', () => {
    const { rerender } = render(<TaskPageJiraTextFallbackNotice rejection={null} />)
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')

    rerender(<TaskPageJiraTextFallbackNotice rejection={PROSE} />)
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toContain('Showing text matches')

    rerender(<TaskPageJiraTextFallbackNotice rejection={null} />)
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe('')
  })
})
