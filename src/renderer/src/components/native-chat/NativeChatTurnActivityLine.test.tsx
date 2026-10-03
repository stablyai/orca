// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'

afterEach(() => cleanup())

describe('NativeChatTurnActivityLine', () => {
  it("reads Stopping over the provider's activity while a person's Stop ends the turn", () => {
    const activity = { kind: 'description', text: 'Running pnpm test' } as const
    const { rerender } = render(<NativeChatTurnActivityLine activity={activity} thinking={false} />)
    expect(screen.getByText('Running pnpm test')).toBeTruthy()

    rerender(<NativeChatTurnActivityLine activity={activity} thinking={false} stopping />)

    expect(screen.getByText('Stopping…')).toBeTruthy()
    expect(screen.queryByText('Running pnpm test')).toBeNull()
  })
})
