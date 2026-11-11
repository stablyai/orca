import { describe, expect, it } from 'vitest'
import {
  checkAgentLaunchModelPreferences,
  launchCatalogOffersEffort
} from '../../../agent-launch/choices/agent-launch-model-preferences'
import {
  sourceControlActionAgentPicksModel,
  sourceControlActionOptions
} from './source-control-action-options'

describe('sourceControlActionOptions and terminal launch catalog split', () => {
  it('routes Antigravity effort to chats only while rejecting terminal --effort', () => {
    const rows = sourceControlActionOptions('antigravity', 'gemini-4-carbon-high')
    expect(rows.map((row) => ({ id: row.option.id, route: row.route }))).toEqual([
      { id: 'effort', route: 'chats' }
    ])
    expect(launchCatalogOffersEffort('antigravity', 'gemini-4-carbon-high', 'high')).toBe(false)
    expect(
      checkAgentLaunchModelPreferences({
        agent: 'antigravity',
        model: 'gemini-4-carbon-high'
      })
    ).toEqual({
      preferences: { model: 'gemini-4-carbon-high' }
    })
    expect(
      checkAgentLaunchModelPreferences({
        agent: 'antigravity',
        model: 'gemini-4-carbon-high',
        effort: 'high'
      })
    ).toMatchObject({
      refusal: { code: 'invalid_argument' }
    })
  })

  it('preserves launch-only catalog support for pi and opencode', () => {
    expect(sourceControlActionAgentPicksModel('pi')).toBe(true)
    expect(sourceControlActionAgentPicksModel('opencode')).toBe(true)
    expect(
      sourceControlActionOptions('pi', 'anthropic/claude-sonnet-4-5').map((row) => row.option.id)
    ).toContain('effort')
  })
})
