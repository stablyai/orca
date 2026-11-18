// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorMessageAsker } from '../../../../shared/connector-message-asker'
import { connectorAvatarSrc } from '../../../../shared/connector-avatar-scheme'
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
  it('names a coworker and the place, and opens the thread in the browser', () => {
    render(<NativeChatConnectorAskerTag asker={SAM} />)
    const tag = screen.getByRole('button', { name: 'Sam Lee in Slack. Open in Slack' })
    expect(tag).toHaveTextContent('Sam Lee·Slack')
    fireEvent.click(tag)
    expect(openOwnedHttpLink).toHaveBeenCalledWith(SAM.url, {
      sourceOwner: { kind: 'local' },
      forceSystemBrowser: true
    })
  })

  it('shows the cached avatar, then initials when it can’t load', () => {
    const { container } = render(<NativeChatConnectorAskerTag asker={SAM} />)
    const image = container.querySelector('img')
    expect(image).toHaveAttribute('src', connectorAvatarSrc(SAM.avatarUrl ?? ''))
    if (!image) {
      throw new Error('no avatar image')
    }
    fireEvent.error(image)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('SL')).toBeInTheDocument()
  })

  it('reads "You" for the owner, without an avatar', () => {
    const { container } = render(
      <NativeChatConnectorAskerTag
        asker={{ ...SAM, role: 'owner', place: { kind: 'direct_message', id: 'D1' } }}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('You·Slack DM')
    expect(container.querySelector('img')).toBeNull()
  })

  it('names an issue or pull request by its own id, and is plain text without a link', () => {
    render(
      <NativeChatConnectorAskerTag
        asker={{
          source: 'linear',
          userId: 'u1',
          name: 'Sam Lee',
          role: 'member',
          place: { kind: 'issue', id: 'ENG-123' }
        }}
      />
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTitle('Sam Lee in ENG-123')).toHaveTextContent('SLSam Lee·ENG-123')
  })
})
