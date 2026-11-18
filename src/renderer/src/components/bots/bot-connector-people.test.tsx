// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectorAvatarUrlOf } from '../../../../shared/connector-avatar-scheme'
import { BotPeopleChips } from './bot-connector-people'

afterEach(cleanup)

const pictures = (): (string | null)[] =>
  [...document.querySelectorAll('img')].map((img) => connectorAvatarUrlOf(img.src))

describe('BotPeopleChips', () => {
  it('shows GitHub people and Slack people saved with one by their picture, others by initials', () => {
    render(
      <BotPeopleChips
        owner="You"
        members={[
          { id: '583231', name: 'octocat', source: 'github' },
          { id: 'U-ana', name: 'Ana', avatarUrl: 'https://avatars.slack-edge.com/ana_72.png' },
          { id: 'U-sam', name: 'Sam Lee' },
          { id: 'L-bea', name: 'Bea Park', source: 'linear', workspaceId: 'org-1' }
        ]}
        onRemove={vi.fn()}
      />
    )
    expect(pictures()).toEqual([
      'https://avatars.githubusercontent.com/u/583231',
      'https://avatars.slack-edge.com/ana_72.png'
    ])
    expect(document.body.textContent).toContain('SL')
    expect(document.body.textContent).toContain('BP')
  })
})
