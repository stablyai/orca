import { describe, expect, it } from 'vitest'
import type { GoogleAccountView } from '../google/google-connect-types'
import { botConnectorServices, formatBotConnectors } from './bot-connectors-view'

const bot = { slack: null, slackApps: [], linear: null, linearWorkspaces: [], github: null }

describe('orca bot connectors', () => {
  it('says per service which tool, as whom, and the one line for a gap', () => {
    const services = botConnectorServices(bot, { gh: 'signed-out', linear: false })
    expect(
      formatBotConnectors({
        bot: 'Scout',
        services,
        workspaces: [],
        workspacesNote: 'Orca Cloud could not list them.'
      })
    ).toBe(
      [
        'GitHub: `gh`, as your owner. Not signed in. Run `gh auth login` on this computer.',
        '  Not connected for wakes: `orca bot connectors --offer github` to be @mentioned or to watch.',
        'Linear: `orca linear`, as your owner. Not signed in. Connect Linear to your bot, or add a Linear API key in Settings › Integrations.',
        '  Not connected for wakes: `orca bot connectors --offer linear` to be @mentioned or to watch.',
        'Slack: `orca slack`, as Scout. Not connected. Run `orca bot connectors --offer slack` to show your owner a Connect card.',
        '',
        'Where Scout is (refs for automations):',
        'Orca Cloud could not list them.'
      ].join('\n')
    )
  })

  it('lists a connected bot, what to approve, and its workspaces by ref', () => {
    const connected = {
      ...bot,
      slackApps: [{ teamId: 'T1', appId: 'A1' }],
      github: {},
      linearWorkspaces: [{ organizationId: 'o1', workspaceName: 'Acme' }]
    }
    const services = botConnectorServices(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: botConnectorServices reads only whether each link is there.
      connected as never,
      { gh: 'missing', linear: true },
      'https://orca.example/approve'
    )
    expect(services.map((service) => [service.source, service.signedIn, service.wakes])).toEqual([
      ['github', false, true],
      ['linear', true, true],
      ['slack', true, true]
    ])
    const printed = formatBotConnectors({
      bot: 'Scout',
      services,
      workspaces: [
        {
          source: 'linear',
          ref: 'linear:o1:workspace',
          label: 'Acme',
          places: [{ ref: 'linear:o1:team:t1', label: 'ENG Engineering' }]
        }
      ]
    })
    expect(printed).toContain(
      'GitHub: `gh`, as your owner. Not signed in. Install the GitHub CLI (gh) on this computer, then run `gh auth login`.'
    )
    expect(printed).toContain('Slack: `orca slack`, as Scout. Connected.')
    expect(printed).toContain('  Ask your owner to approve: https://orca.example/approve')
    expect(printed).toContain(
      'linear:o1:workspace  linear: Acme\n  linear:o1:team:t1  ENG Engineering'
    )
  })

  it('adds a Google row with each account’s services, or the one step that is missing', () => {
    const ada: GoogleAccountView = {
      email: 'ada@acme.dev',
      status: 'connected',
      connectedAt: 1,
      services: [
        { service: 'gmail', state: 'ready' },
        { service: 'calendar', state: 'api-disabled' }
      ]
    }
    const row = (google: boolean | undefined, accounts: GoogleAccountView[]) =>
      botConnectorServices(
        { ...bot, google },
        { gh: 'signed-in', linear: true, google: accounts }
      ).find((service) => service.source === 'google')
    const on = row(true, [ada])
    expect(on).toMatchObject({ signedIn: true, wakes: false })
    const printed = formatBotConnectors({ bot: 'Scout', services: on ? [on] : [], workspaces: [] })
    expect(printed).toContain(
      'Google: `orca gmail|calendar|contacts`, as your owner. Signed in.\n  ada@acme.dev: Gmail ready, Calendar API off'
    )
    expect(printed).not.toContain('--offer google')
    // A host that reports no Google sign-ins shows no row.
    expect(
      botConnectorServices(bot, { gh: 'signed-in', linear: true }).map((s) => s.source)
    ).toEqual(['github', 'linear', 'slack'])
  })
})
