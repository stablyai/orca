// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ActivityPrototypePage', () => ({ default: () => <p>Agent feed</p> }))
vi.mock('../orchestration-history/RunHistoryBrowser', () => ({
  RunHistoryBrowser: ({ onBack }: { onBack: () => void }) => (
    <button onClick={onBack}>Return to Agents</button>
  )
}))
import ActivityPage from './ActivityPage'

afterEach(cleanup)

describe('Agents history entry', () => {
  it('opens history from the regular Agents page and returns to the feed', () => {
    render(<ActivityPage />)
    expect(screen.getByText('Agent feed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }))
    expect(screen.queryByText('Agent feed')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Return to Agents' }))
    expect(screen.getByText('Agent feed')).toBeInTheDocument()
  })
})
