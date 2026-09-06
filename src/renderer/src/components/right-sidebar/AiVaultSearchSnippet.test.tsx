// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AiVaultSearchEvidenceLine, aiVaultSearchSnippetSegments } from './AiVaultSearchSnippet'

afterEach(cleanup)

describe('aiVaultSearchSnippetSegments', () => {
  it('splits a snippet on its match markers', () => {
    expect(aiVaultSearchSnippetSegments('fix the [[strict]] mode [[bug]]')).toEqual([
      { text: 'fix the ', matched: false },
      { text: 'strict', matched: true },
      { text: ' mode ', matched: false },
      { text: 'bug', matched: true }
    ])
  })

  it('keeps literal brackets from a transcript as plain text', () => {
    expect(aiVaultSearchSnippetSegments('read arr[0] then [[index]] it')).toEqual([
      { text: 'read arr[0] then ', matched: false },
      { text: 'index', matched: true },
      { text: ' it', matched: false }
    ])
  })

  it('keeps a phrase match that spans a line break as one marked segment', () => {
    expect(aiVaultSearchSnippetSegments('fix the [[terminal\npath]] now')).toEqual([
      { text: 'fix the ', matched: false },
      { text: 'terminal\npath', matched: true },
      { text: ' now', matched: false }
    ])
  })

  it('leaves an unmarked snippet as one plain segment', () => {
    expect(aiVaultSearchSnippetSegments('no markers here')).toEqual([
      { text: 'no markers here', matched: false }
    ])
  })
})

describe('AiVaultSearchEvidenceLine', () => {
  it('renders the role and marks the matched terms', () => {
    render(
      <AiVaultSearchEvidenceLine
        evidence={{ role: 'user', timestamp: null, snippet: 'fix the [[strict]] mode' }}
      />
    )
    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.getByText('strict').className).toContain('bg-amber-500/30')
  })

  it('renders nothing without a snippet', () => {
    const { container } = render(
      <AiVaultSearchEvidenceLine evidence={{ role: 'assistant', timestamp: null, snippet: '' }} />
    )
    expect(container.firstChild).toBeNull()
  })
})
