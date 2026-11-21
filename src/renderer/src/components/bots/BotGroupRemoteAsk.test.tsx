// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { BotGroupRemoteAsk as RemoteAsk } from '../../../../shared/bots/bot-group'
import { BotGroupRemoteAsk } from './BotGroupRemoteAsk'

const base: RemoteAsk = {
  environmentId: 'ws',
  botId: 'builds',
  chatSessionId: 'chat-builds',
  computer: 'Workstation',
  joinedAfter: 0,
  name: 'Nightly builds',
  avatar: null,
  agent: 'claude',
  requestId: 'msg_000000000001',
  state: 'sent'
}

afterEach(cleanup)

describe('a question to a bot on another computer', () => {
  it('keeps the row label short and puts the sentence under it when delivery is unknown', () => {
    render(
      <BotGroupRemoteAsk ask={{ ...base, state: 'unknown', error: 'The request timed out' }} />
    )
    expect(screen.getByRole('status').textContent).toBe('Delivery unknown')
    expect(screen.getByText('May still answer on Workstation. The request timed out.')).toBeTruthy()
  })

  it('shows why a question was not sent, under a short label', () => {
    render(
      <BotGroupRemoteAsk
        ask={{
          ...base,
          state: 'failed',
          error: "Couldn't reach Workstation. It's offline. Post again to retry."
        }}
      />
    )
    expect(screen.getByRole('status').textContent).toBe('Not sent to Workstation')
    expect(
      screen.getByText("Couldn't reach Workstation. It's offline. Post again to retry.")
    ).toBeTruthy()
  })

  it("names the computer, not the bot again, when the bot didn't answer or was stopped", () => {
    render(<BotGroupRemoteAsk ask={{ ...base, reply: { kind: 'notice' } }} />)
    expect(screen.getByText("Didn't answer on Workstation")).toBeTruthy()
    // The label is a live region before anything goes wrong, so a later failure is announced.
    expect(screen.getByRole('status').textContent).toBe("Didn't answer on Workstation")
    cleanup()
    render(<BotGroupRemoteAsk ask={{ ...base, stopped: true }} />)
    expect(screen.getByText('Stopped here')).toBeTruthy()
    expect(screen.getByText('May still answer on Workstation.')).toBeTruthy()
  })
})
