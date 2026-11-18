// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { HideBotCreatedFilterRow } from './HideBotCreatedFilterRow'

vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => [],
  useBotsEnabled: () => true
}))

describe('HideBotCreatedFilterRow', () => {
  afterEach(() => {
    cleanup()
    useAppStore.setState({ hideBotCreatedWorkspaces: true })
  })

  it('stays reachable while turned off, even with no bots', () => {
    useAppStore.setState({ hideBotCreatedWorkspaces: false })
    render(<HideBotCreatedFilterRow />)
    expect(screen.getByText('Hide bot workspaces')).toBeTruthy()
  })
})
