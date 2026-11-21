// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { SlackOpenAppButton } from './SlackOpenAppButton'

const opened = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/lib/bot-host-page', () => ({ openBotHostPageOrSay: opened.open }))

const bot: Pick<Bot, 'id' | 'name' | 'hostId'> = { id: 'bot-1', name: 'Scout', hostId: 'local' }

afterEach(cleanup)

it('opens the installed app’s messages in Slack, and shows nothing before it is installed', () => {
  const { rerender } = render(<SlackOpenAppButton bot={bot} slack={{ state: 'not_created' }} />)
  expect(screen.queryByRole('button')).toBeNull()
  rerender(
    <SlackOpenAppButton
      bot={bot}
      slack={{
        state: 'installed',
        teamId: 'T05',
        appId: 'A1',
        botUserId: 'UB',
        installerUserId: 'U07'
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: /Message it in Slack/ }))
  expect(opened.open).toHaveBeenCalledWith(
    'local',
    'https://slack.com/app_redirect?app=A1&team=T05',
    {
      bot,
      local: 'system'
    }
  )
})

it('closes what shows it when the page opens in Orca’s own browser, and not when it opens elsewhere', () => {
  const close = vi.fn()
  render(
    <SlackOpenAppButton
      bot={bot}
      slack={{
        state: 'installed',
        teamId: 'T05',
        appId: 'A1',
        botUserId: 'UB',
        installerUserId: 'U07'
      }}
      onOpenedInOrca={close}
    />
  )
  opened.open.mockReturnValueOnce('system')
  fireEvent.click(screen.getByRole('button', { name: /Message it in Slack/ }))
  expect(close).not.toHaveBeenCalled()
  opened.open.mockReturnValueOnce('orca-browser')
  fireEvent.click(screen.getByRole('button', { name: /Message it in Slack/ }))
  expect(close).toHaveBeenCalledTimes(1)
})
