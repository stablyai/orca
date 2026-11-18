// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { HideBotCreatedFilterRow } from './HideBotCreatedFilterRow'

const catalog = vi.hoisted((): { bots: { id: string }[] } => ({ bots: [] }))

vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => catalog.bots,
  useBotsEnabled: () => true
}))

describe('HideBotCreatedFilterRow', () => {
  afterEach(() => {
    cleanup()
    catalog.bots = []
    useAppStore.setState({ hideBotCreatedWorkspaces: true })
  })

  it('stays out of the menu with no bots and the default left on', () => {
    useAppStore.setState({ hideBotCreatedWorkspaces: true })
    render(<HideBotCreatedFilterRow />)
    expect(screen.queryByText('Hide bot workspaces')).toBeNull()
  })

  it('shows once a bot exists', () => {
    catalog.bots = [{ id: 'bot-1' }]
    render(<HideBotCreatedFilterRow />)
    expect(screen.getByText('Hide bot workspaces')).toBeTruthy()
  })

  it('stays reachable while turned off, even with no bots', () => {
    useAppStore.setState({ hideBotCreatedWorkspaces: false })
    render(<HideBotCreatedFilterRow />)
    expect(screen.getByText('Hide bot workspaces')).toBeTruthy()
  })
})
