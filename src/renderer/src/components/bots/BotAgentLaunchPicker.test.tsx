// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/agent/AgentLaunchPicker', () => ({
  AgentLaunchPicker: () => null
}))
vi.mock('@/components/agent/AgentLaunchSetupButton', () => ({
  useAgentPickerDraftScope: (key: string) => key
}))
vi.mock('@/components/agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: () => []
}))

import { BotAgentLaunchPicker, type BotAgentSetup } from './BotAgentLaunchPicker'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'

afterEach(cleanup)

const CHAT_DEFAULT = /Using your chat default/

function renderPicker(value: BotAgentSetup) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked inventory never reads the menu model.
  const model = { state: 'loading' } as unknown as NewTabAgentMenuModel
  render(
    <BotAgentLaunchPicker model={model} choices={['claude']} value={value} onChange={() => {}} />
  )
}

describe("the bot's agent picker", () => {
  it('says the model shown is the chat default when the bot has none of its own', () => {
    renderPicker({ agent: 'claude' })

    expect(screen.getByText(CHAT_DEFAULT)).toBeTruthy()
    expect(screen.queryByText('Use chat defaults')).toBeNull()
  })

  it('drops the label once the bot keeps its own model, offering the way back instead', () => {
    renderPicker({ agent: 'claude', launch: { model: 'claude-haiku-5-5' } })

    expect(screen.queryByText(CHAT_DEFAULT)).toBeNull()
    expect(screen.getByText('Use chat defaults')).toBeTruthy()
  })
})
