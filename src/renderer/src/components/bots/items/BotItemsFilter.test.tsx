// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { BOT_ITEM_NO_FILTER } from '../../../../../shared/bots/bot-item-groups'
import { BotItemsFilterButton } from './BotItemsFilter'

afterEach(cleanup)

it('offers only Needs you only on a bot’s page, its chats being in the sidebar', () => {
  const items = [
    makeTestBotItem(1, { status: 'needs_you' }),
    makeTestBotItem(2, { chat: { id: 'chat-side', kind: 'chat', title: 'Release notes' } })
  ]
  render(
    <TooltipProvider>
      <BotItemsFilterButton items={items} filter={BOT_ITEM_NO_FILTER} onFilter={() => {}} />
    </TooltipProvider>
  )

  fireEvent.keyDown(screen.getByRole('button', { name: 'Filter items' }), { key: 'Enter' })

  expect(screen.getByRole('menuitemcheckbox', { name: /Needs you only/ })).toBeTruthy()
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  expect(screen.queryByText('Release notes')).toBeNull()
})
