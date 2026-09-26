// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TaskPageJiraTextFallbackNotice } from './task-page-jira-text-fallback-notice'

afterEach(cleanup)

const REASON = "Field 'login' does not exist or you do not have permission to view it."

describe('TaskPageJiraTextFallbackNotice', () => {
  it("keeps Jira's reason behind Details", () => {
    render(<TaskPageJiraTextFallbackNotice reason={REASON} />)
    expect(screen.getByText(/Showing text matches/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Showing text matches')
    expect(screen.queryByText(REASON)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText(REASON)).toBeTruthy()
  })

  it('omits Details when Jira gave no reason', () => {
    render(<TaskPageJiraTextFallbackNotice reason="" />)
    expect(screen.getByText(/Showing text matches/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('updates one mounted live region instead of inserting a new one', () => {
    const { rerender } = render(<TaskPageJiraTextFallbackNotice reason={null} />)
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')

    rerender(<TaskPageJiraTextFallbackNotice reason={REASON} />)
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toContain('Showing text matches')

    rerender(<TaskPageJiraTextFallbackNotice reason={null} />)
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe('')
  })
})
