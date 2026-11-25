// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ActiveOption } from './tab-create-entry-active-option'
import { useNetworkSafeTabEntrySelection } from './tab-create-entry-network-selection'

const chat = (id: string, label: string): ActiveOption => ({
  kind: 'agent',
  option: { agent: 'claude', aliases: [], label, id }
})

const select = (activeOptions: ActiveOption[], pinnedOptionId: string | null) =>
  renderHook(() =>
    useNetworkSafeTabEntrySelection({
      activeOptions,
      fileIndexFailed: false,
      fileIndexReady: true,
      forcedSearch: false,
      menuOpen: true,
      pinnedOptionId,
      query: 'chat'
    })
  ).result.current

describe('useNetworkSafeTabEntrySelection', () => {
  const home = chat('bot-chat:home', 'New Home Chat')
  const codex = chat('bot-chat:codex', 'New Codex Chat')

  it('keeps the bot chat the user picked', () => {
    expect(select([home, codex], 'bot-chat:codex').selectedActiveOption).toBe(codex)
  })

  it('hands Enter to nothing when the picked bot chat drops out', () => {
    // Enter must not fall through to the first row, here a Home Chat reset.
    const selection = select([home], 'bot-chat:codex')
    expect(selection.activeSelectedIndex).toBeNull()
    expect(selection.selectedActiveOption).toBeUndefined()
  })

  it('ranks the first row when nothing was picked', () => {
    expect(select([home, codex], null).selectedActiveOption).toBe(home)
  })
})
