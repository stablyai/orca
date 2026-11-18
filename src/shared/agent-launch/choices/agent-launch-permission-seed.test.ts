import { describe, expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  type AgentLaunchSettingsMutation,
  type AgentLaunchSettingsSource
} from './agent-launch-settings'

const UNTOUCHED: AgentLaunchSettingsSource = {
  agentPermissionDefault: 'full-access',
  agentPermissionOverrides: {}
}
const SEED: AgentLaunchSettingsMutation = {
  type: 'seed-permission',
  choice: 'own',
  overrides: { claude: 'ask' }
}

/** What the host's settings write does: reduce against the current settings, then merge. */
function apply(settings: AgentLaunchSettingsSource, mutation: AgentLaunchSettingsMutation) {
  return { ...settings, ...agentLaunchSettingsMutationUpdates(settings, mutation, 'linux') }
}

describe('seed-permission', () => {
  it('replaces the product default with the seeded choices', () => {
    expect(apply(UNTOUCHED, SEED)).toMatchObject({
      agentPermissionDefault: 'own',
      agentPermissionOverrides: { claude: 'ask' }
    })
  })

  it('never overwrites a choice saved after the desktop decided to seed', () => {
    // Another settings window or phone sets Ask while Add is still finishing.
    const chosen = apply(UNTOUCHED, { type: 'permission', choice: 'ask' })
    expect(apply(chosen, SEED)).toEqual(chosen)
    const perAgent = apply(UNTOUCHED, { type: 'permission', choice: 'own', agent: 'codex' })
    expect(apply(perAgent, SEED)).toEqual(perAgent)
  })

  it('drops agents and choices the host does not offer', () => {
    const seeded = apply(UNTOUCHED, {
      type: 'seed-permission',
      choice: 'own',
      overrides: { 'future-agent': 'ask', aider: 'accept-edits' }
    })
    expect(seeded.agentPermissionOverrides).toEqual({})
  })

  it('leaves a host that stores permissions as launch text alone', () => {
    expect(agentLaunchSettingsMutationUpdates({ agentDefaultArgs: {} }, SEED, 'linux')).toEqual({})
  })
})
