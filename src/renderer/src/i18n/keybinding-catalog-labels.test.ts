import { beforeEach, describe, expect, it } from 'vitest'

import type { KeybindingActionId, KeybindingDefinition } from '../../../shared/keybindings'
import { KEYBINDING_DEFINITIONS } from '../../../shared/keybindings'
import { i18n } from './i18n'
import {
  translateKeybindingGroupTitle,
  translateKeybindingTitle
} from './keybinding-catalog-labels'

describe('keybinding-catalog-labels', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('translates a statically catalogued shortcut title', async () => {
    const definition: Pick<KeybindingDefinition, 'id' | 'title'> = {
      id: 'worktree.quickOpen',
      title: 'Go to File'
    }
    expect(translateKeybindingTitle(definition)).toBe('Go to File')

    await i18n.changeLanguage('tr')
    expect(translateKeybindingTitle(definition)).toBe('Dosyaya Git')

    await i18n.changeLanguage('en')
  })

  it('translates dynamically generated agent-tab titles by interpolating the agent name', async () => {
    const definition: Pick<KeybindingDefinition, 'id' | 'title'> = {
      id: 'tab.newAgent.claude',
      title: 'New Claude tab'
    }
    expect(translateKeybindingTitle(definition)).toBe('New Claude tab')

    await i18n.changeLanguage('tr')
    expect(translateKeybindingTitle(definition)).toBe('Yeni Claude sekmesi')

    await i18n.changeLanguage('en')
  })

  it.each([
    ['browser.annotateElement', 'Annotate Page Element', 'Sayfa Öğesine Açıklama Ekle'],
    [
      'sidebar.childWorkspaces.toggle',
      'Toggle Child Workspaces',
      'Alt Çalışma Alanlarını Göster/Gizle'
    ]
  ] as const)('translates the new %s shortcut', async (id, title, expected) => {
    const definition = { id, title }
    expect(translateKeybindingTitle(definition)).toBe(title)
    await i18n.changeLanguage('tr')
    expect(translateKeybindingTitle(definition)).toBe(expected)
    await i18n.changeLanguage('en')
  })

  it('falls back to the literal title for an unrecognized agent-tab id', () => {
    const definition = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately not a real TuiAgent, to exercise the fallback branch.
      id: 'tab.newAgent.not-a-real-agent' as KeybindingActionId,
      title: 'New Mystery Agent tab'
    }
    expect(translateKeybindingTitle(definition)).toBe('New Mystery Agent tab')
  })

  it('translates the dynamically generated Agents group title', async () => {
    expect(translateKeybindingGroupTitle('Agents')).toBe('Agents')

    await i18n.changeLanguage('tr')
    expect(translateKeybindingGroupTitle('Agents')).toBe('Ajanlar')

    await i18n.changeLanguage('en')
  })

  it('passes through an unrecognized group title unchanged', () => {
    expect(translateKeybindingGroupTitle('Not A Real Group')).toBe('Not A Real Group')
  })

  it('translates the current chat shortcut and its group', async () => {
    await i18n.changeLanguage('tr')
    expect(translateKeybindingTitle({ id: 'chat.find', title: 'Find in chat' })).toBe(
      'Sohbette bul'
    )
    expect(translateKeybindingGroupTitle('Chat')).toBe('Sohbet')
  })

  it('catalogues every static shortcut title and built-in group in Turkish', async () => {
    await i18n.changeLanguage('tr')
    for (const definition of KEYBINDING_DEFINITIONS) {
      if (!definition.id.startsWith('tab.newAgent.')) {
        expect(
          typeof i18n.getResource(
            'tr',
            'translation',
            `auto.lib.keybindings.titles.${definition.id}.title`
          ),
          definition.id
        ).toBe('string')
      }
      expect(translateKeybindingGroupTitle(definition.group), definition.group).not.toBe(
        definition.group
      )
    }
  })
})
