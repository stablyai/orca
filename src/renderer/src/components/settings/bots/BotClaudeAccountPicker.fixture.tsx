import { defineFixture } from '../../../component-fixtures/component-fixture'
import { BotClaudeAccountSelect } from './BotClaudeAccountPicker'
import type { BotClaudeAccountChoices } from './bot-claude-account-choices'

const accounts: BotClaudeAccountChoices['choices'] = [
  { value: 'system', label: 'System default' },
  { value: 'a1', label: 'Work (work@example.com)', detail: 'Acme' },
  { value: 'a2', label: 'me@example.com', detail: 'Personal' },
  { value: 'a3', label: 'old@example.com', detail: 'Signed out · Personal', disabled: true }
]

const openSelect = async (frame: HTMLElement): Promise<void> => {
  frame
    .querySelector('[data-slot="select-trigger"]')
    ?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
  await new Promise((resolve) => setTimeout(resolve, 300))
}

export const followHost = defineFixture({
  width: 420,
  render: () => (
    <BotClaudeAccountSelect
      options={{ choices: accounts, selected: 'follow-host', unknown: null }}
      known
      hostLabel={null}
      onChange={() => {}}
    />
  )
})

export const openOnServer = defineFixture({
  width: 420,
  render: () => (
    <BotClaudeAccountSelect
      options={{ choices: accounts, selected: 'a1', unknown: null }}
      known
      hostLabel="Build server"
      onChange={() => {}}
    />
  ),
  interact: openSelect
})

export const unavailable = defineFixture({
  width: 420,
  render: () => (
    <BotClaudeAccountSelect
      options={{ choices: accounts, selected: 'unknown-account', unknown: 'gone@example.com' }}
      known
      hostLabel={null}
      onChange={() => {}}
    />
  ),
  interact: openSelect
})
