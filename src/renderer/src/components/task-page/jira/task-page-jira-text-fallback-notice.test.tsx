// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TaskPageJiraTextFallbackNotice } from './task-page-jira-text-fallback-notice'

afterEach(cleanup)

const REASON = "Field 'login' does not exist or you do not have permission to view it."
const PROSE = { reason: REASON, likelyTypo: false }

describe('TaskPageJiraTextFallbackNotice', () => {
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
