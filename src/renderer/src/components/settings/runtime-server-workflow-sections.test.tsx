// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('./RuntimePairingUrlGenerator', () => ({
  RuntimePairingUrlGenerator: () => <div data-testid="pairing-url-generator" />
}))

vi.mock('./MachineNameField', () => ({
  MachineNameField: ({ id }: { id?: string }) => (
    <div data-testid="machine-name-field" data-id={id} />
  )
}))

import { RuntimeServerShareSection } from './runtime-server-workflow-sections'

describe('RuntimeServerShareSection', () => {
  afterEach(() => cleanup())

  it('names this host before the link generator other devices will use to reach it', () => {
    render(
      <RuntimeServerShareSection shareServerFormOpen={false} onToggleShareServerForm={vi.fn()} />
    )

    const field = screen.getByTestId('machine-name-field')
    expect(field).toHaveAttribute('data-id', 'runtime-share-machine-name')
    const generator = screen.getByTestId('pairing-url-generator')
    expect(field.compareDocumentPosition(generator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText('Share this Orca server')).toBeVisible()
  })
})
