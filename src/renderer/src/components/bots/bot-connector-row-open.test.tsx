// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { BotConnectorRowFrame } from './BotConnectorRow'
import { BotConnectorRowKey, forgetBotConnectorRowsOpen } from './bot-connector-row-open'

function row(connector: string, defaultOpen = false): ReactElement {
  return (
    <BotConnectorRowKey.Provider value={connector}>
      <BotConnectorRowFrame
        icon={null}
        name="Slack"
        description=""
        status={null}
        defaultOpen={defaultOpen}
      >
        <p>How to ask</p>
      </BotConnectorRowFrame>
    </BotConnectorRowKey.Provider>
  )
}

afterEach(() => {
  cleanup()
  forgetBotConnectorRowsOpen()
})

describe('a connector row that stays mounted while its connector changes', () => {
  it('shows each connector as the owner left it, without writing one over the other', async () => {
    const user = userEvent.setup()
    const { rerender } = render(row('host\0bot-1\0slack'))
    const header = (): HTMLElement => screen.getByRole('button', { name: 'Slack' })
    await user.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'true')

    rerender(row('host\0bot-2\0slack'))
    expect(header()).toHaveAttribute('aria-expanded', 'false')

    rerender(row('host\0bot-1\0slack'))
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    rerender(row('host\0bot-2\0slack'))
    expect(header()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a row that needs the owner for the next connector, though the last one was closed', async () => {
    const user = userEvent.setup()
    const { rerender } = render(row('host\0bot-1\0github', true))
    const header = (): HTMLElement => screen.getByRole('button', { name: 'Slack' })
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    await user.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'false')

    rerender(row('host\0bot-2\0github', true))
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    // The first bot's closing stays its own.
    rerender(row('host\0bot-1\0github', true))
    expect(header()).toHaveAttribute('aria-expanded', 'false')
  })
})
