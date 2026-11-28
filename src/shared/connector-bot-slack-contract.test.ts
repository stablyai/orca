import { expect, it } from 'vitest'
import { ConnectorBotSlackStateResponse, slackTeamState } from './connector-bot-slack-contract'

it('keeps each Slack workspace’s reply-link setting, including the opt-out', () => {
  const install = {
    state: 'installed',
    appId: 'A1',
    botUserId: 'UB',
    installerUserId: 'U1'
  }
  const state = ConnectorBotSlackStateResponse.parse({
    ...install,
    teamId: 'T-old',
    teams: [
      { ...install, teamId: 'T-on', showOrcaThreadLink: true },
      { ...install, teamId: 'T-off', showOrcaThreadLink: false }
    ]
  })

  expect(slackTeamState(state, 'T-old')).not.toHaveProperty('showOrcaThreadLink')
  expect(slackTeamState(state, 'T-on')).toHaveProperty('showOrcaThreadLink', true)
  expect(slackTeamState(state, 'T-off')).toHaveProperty('showOrcaThreadLink', false)
})
