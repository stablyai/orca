import { afterEach, describe, expect, it } from 'vitest'
import {
  agentTabActionId,
  getKeybindingDefinition,
  type KeybindingActionId,
  type KeybindingDefinition
} from '../../../../shared/keybindings'
import { i18n } from '@/i18n/i18n'
import { localizeKeybindingDefinition } from './keybinding-title-copy'

function definition(actionId: KeybindingActionId): KeybindingDefinition {
  const found = getKeybindingDefinition(actionId)
  if (!found) {
    throw new Error(`missing ${actionId}`)
  }
  return found
}

describe('localizeKeybindingDefinition', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('localizes built-in titles, keeps English searchable, and leaves plugin titles alone', async () => {
    await i18n.changeLanguage('ko')
    const quickOpen = definition('worktree.quickOpen')

    const localized = localizeKeybindingDefinition(quickOpen)
    expect(localized.title).not.toBe(quickOpen.title)
    expect(localized.group).not.toBe(quickOpen.group)
    expect(localized.searchKeywords).toEqual(
      expect.arrayContaining([quickOpen.title, quickOpen.group])
    )
    const agentTab = definition(agentTabActionId('claude'))
    const agentTitle = localizeKeybindingDefinition(agentTab).title
    expect(agentTitle).not.toBe(agentTab.title)
    expect(agentTitle).toContain('Claude')

    const plugin: KeybindingDefinition = {
      ...quickOpen,
      id: 'plugin:orca-samples.tasks/open',
      title: 'Open Tasks — Tasks',
      group: 'Plugins'
    }
    expect(localizeKeybindingDefinition(plugin)).toBe(plugin)
  })
})
