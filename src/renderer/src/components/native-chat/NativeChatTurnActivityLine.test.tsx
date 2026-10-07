// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatLiveLine } from '../../../../shared/native-chat-live-line'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'

afterEach(() => cleanup())

describe('NativeChatTurnActivityLine', () => {
  it("reads Stopping over the provider's activity while a person's Stop ends the turn", () => {
    const line: NativeChatLiveLine = {
      thinking: false,
      stopping: false,
      activityText: 'Running pnpm test',
      reasoning: null
    }
    const { rerender } = render(<NativeChatTurnActivityLine line={line} />)
    expect(screen.getByText('Running pnpm test')).toBeTruthy()

    rerender(<NativeChatTurnActivityLine line={{ ...line, stopping: true }} />)

    expect(screen.getByText('Stopping…')).toBeTruthy()
    expect(screen.queryByText('Running pnpm test')).toBeNull()
  })
})
