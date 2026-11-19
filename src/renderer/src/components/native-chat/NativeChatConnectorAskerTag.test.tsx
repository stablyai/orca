// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorMessageAsker } from '../../../../shared/connector-message-asker'
import { NativeChatConnectorAskerTag } from './NativeChatConnectorAskerTag'

const openOwnedHttpLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/browser/navigation/http-link-routing', () => ({ openOwnedHttpLink }))

const SAM: ConnectorMessageAsker = {
  source: 'slack',
  userId: 'U0SAM',
  name: 'Sam Lee',
  role: 'member',
  place: { kind: 'public_channel', id: 'C9' },
  url: 'https://app.slack.com/client/T1/C9/thread/C9-1.2',
  avatarUrl: 'https://avatars.slack-edge.com/sam_72.png'
}

afterEach(() => {
  cleanup()
  openOwnedHttpLink.mockReset()
})

describe('NativeChatConnectorAskerTag', () => {
  it('opens the thread in the system browser', () => {
    render(<NativeChatConnectorAskerTag asker={SAM} />)
    const tag = screen.getByRole('button', { name: 'Sam Lee in Slack. Open in Slack' })
    fireEvent.click(tag)
    expect(openOwnedHttpLink).toHaveBeenCalledWith(SAM.url, {
      sourceOwner: { kind: 'local' },
      forceSystemBrowser: true
    })
  })
})
