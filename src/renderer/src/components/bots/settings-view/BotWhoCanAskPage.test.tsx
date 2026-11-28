// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { BotWhoCanAskPage } from './BotWhoCanAskPage'

const feature = vi.hoisted(() => ({ on: false }))
vi.mock('../paired-server-asks-on', () => ({ pairedServerAsksOn: () => feature.on }))
vi.mock('../bot-connector-entries', () => ({ useBotConnectorEntries: () => [] }))
vi.mock('../../settings/bots/BotConnectorsSection', () => ({
  BotNoConnectors: () => <p>No connectors</p>
}))
vi.mock('./BotPairedServersWhoCanAsk', () => ({
  BotPairedServersWhoCanAsk: () => <h3>Paired servers</h3>
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page reads only the bot's host.
const bot = { id: 'docs', name: 'Docs', hostId: 'local' } as Bot

afterEach(() => {
  cleanup()
  feature.on = false
})

describe('Who can ask, paired servers', () => {
  it('shows no Paired servers section while this computer takes no asks from paired servers', () => {
    render(<BotWhoCanAskPage bot={bot} />)
    expect(screen.queryByText('Paired servers')).toBeNull()
  })

  it('shows the section with no connector once this computer takes their asks', () => {
    feature.on = true
    render(<BotWhoCanAskPage bot={bot} />)
    expect(screen.getByText('Paired servers')).toBeTruthy()
    expect(screen.getByText('No connectors')).toBeTruthy()
  })
})
