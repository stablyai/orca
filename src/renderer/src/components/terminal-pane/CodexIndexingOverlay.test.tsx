// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodexIndexingOverlay, formatCodexIndexingProgress } from './CodexIndexingOverlay'

describe('formatCodexIndexingProgress', () => {
  it('extracts the date from a rollout cursor path', () => {
    expect(
      formatCodexIndexingProgress('sessions/2026/07/02/rollout-2026-07-02T07-08-32.jsonl')
    ).toBe('2026-07-02')
  })

  it('handles Windows separators', () => {
    expect(formatCodexIndexingProgress('sessions\\2026\\07\\02\\rollout-x.jsonl')).toBe(
      '2026-07-02'
    )
  })

  it('returns null for null or unrecognized cursors', () => {
    expect(formatCodexIndexingProgress(null)).toBeNull()
    expect(formatCodexIndexingProgress('something-else')).toBeNull()
  })
})

describe('CodexIndexingOverlay', () => {
  it('shows the indexing headline and auto-start hint', () => {
    render(<CodexIndexingOverlay state={{ lastWatermark: null }} />)
    expect(screen.getByText('Indexing Codex session history…')).toBeTruthy()
    expect(screen.getByText('Codex will start automatically when indexing finishes.')).toBeTruthy()
  })

  it('shows a progress date when the cursor is parseable', () => {
    render(
      <CodexIndexingOverlay state={{ lastWatermark: 'sessions/2026/07/02/rollout-x.jsonl' }} />
    )
    expect(
      screen.getByText(
        'Indexed through 2026-07-02. Codex will start automatically when indexing finishes.'
      )
    ).toBeTruthy()
  })
})
