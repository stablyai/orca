// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiVaultSearchConsentCard, AiVaultSearchTitlesOnlyNotice } from './AiVaultSearchConsentCard'

afterEach(cleanup)

describe('AiVaultSearchConsentCard', () => {
  it('states the cost and offers both choices', () => {
    render(<AiVaultSearchConsentCard enabling={false} onEnable={vi.fn()} onDismiss={vi.fn()} />)

    expect(screen.getByText('Search inside conversations')).toBeTruthy()
    expect(screen.getByText(/local index of your agent transcripts/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
  })

  it('reports each choice to its own handler', () => {
    const onEnable = vi.fn()
    const onDismiss = vi.fn()
    render(<AiVaultSearchConsentCard enabling={false} onEnable={onEnable} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))

    expect(onEnable).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('disables only the affirmative action while the write is in flight', () => {
    render(<AiVaultSearchConsentCard enabling onEnable={vi.fn()} onDismiss={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Enable' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Not now' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('AiVaultSearchTitlesOnlyNotice', () => {
  it('names what search is doing instead and offers the card back', () => {
    const onReopen = vi.fn()
    render(<AiVaultSearchTitlesOnlyNotice onReopen={onReopen} />)

    expect(screen.getByText(/Titles only/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Search inside conversations' }))
    expect(onReopen).toHaveBeenCalledTimes(1)
  })
})
