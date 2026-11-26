import { expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import {
  explicitStructuredLaunchSeedOptions,
  structuredLaunchSeedOptions
} from '../../../../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import { botSettingsModelLabel } from './bot-settings-model-label'

const catalog = {
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: true,
  models: [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', isDefault: true, efforts: [] },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2-Astra', isDefault: false, efforts: [] }
  ]
} satisfies AgentSessionModelCatalogResult

it('names a paired host’s saved launch seed ahead of its workspace catalog default', () => {
  const settings = { nativeChatSessionOptions: { codex: { model: 'gpt-6.2-astra' } } }
  const chat = structuredLaunchSeedOptions(settings, 'codex')
  const background = explicitStructuredLaunchSeedOptions(settings, 'codex')
  expect(botSettingsModelLabel('codex', catalog, chat?.model)).toMatchObject({
    id: 'gpt-6.2-astra',
    label: 'GPT-6.2-Astra'
  })
  expect(botSettingsModelLabel('codex', catalog, background?.model)?.label).toBe('GPT-6.2-Sol')
  expect(botSettingsModelLabel('codex', catalog, 'custom-model')?.label).toBe('custom-model')
  expect(
    botSettingsModelLabel('codex', { ...catalog, listingNamesConfiguredModel: false }, undefined)
  ).toBeUndefined()
})

it('keeps a late Settings reply only when it agrees with the observed menu model', () => {
  expect(botSettingsModelLabel('codex', catalog, undefined, 'gpt-6.2-sol')).toEqual({
    id: 'gpt-6.2-sol',
    label: 'GPT-6.2-Sol'
  })
  expect(botSettingsModelLabel('codex', catalog, 'gpt-6.2-astra', 'gpt-6.2-sol')).toBeUndefined()
})
