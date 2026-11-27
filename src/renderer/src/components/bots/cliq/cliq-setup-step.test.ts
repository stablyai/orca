import { describe, expect, it } from 'vitest'
import type { BotCliqView } from '@/lib/bot-cliq-state'
import type { ConnectorConnectView } from '@/lib/connector-connect-state'
import { CLIQ_OTHER_ORG, botCliqSetupStep, type CliqSignIn } from './cliq-setup-step'

function signIn(orgId: string, expired?: true): CliqSignIn {
  return {
    orgId,
    name: orgId,
    dataCenter: 'eu',
    userId: `u-${orgId}`,
    userName: 'Ada',
    expired
  }
}

function ready(...orgs: CliqSignIn[]): BotCliqView {
  return { status: 'ready', cliq: { orgs } }
}

function linkedTo(orgId: string): ConnectorConnectView {
  return {
    status: 'linked',
    link: {
      identity: { userId: 'u', name: 'Ada', handle: 'ada' },
      org: { orgId, name: orgId, dataCenter: 'eu' },
      install: 'installed'
    }
  }
}

const IDLE: ConnectorConnectView = { status: 'idle' }
const repair = (target: string) => ({ target, picked: null, done: false })

describe('botCliqSetupStep, repairing a row', () => {
  it('asks to sign in again while the row is expired and no sign-in happened', () => {
    const a = signIn('A', true)
    expect(botCliqSetupStep(ready(a), IDLE, repair('A'))).toEqual({
      kind: 'expired',
      org: a
    })
  })

  it('turns on the row once the sign-in reaches its organization', () => {
    const a = signIn('A')
    expect(botCliqSetupStep(ready(a), linkedTo('A'), repair('A'))).toEqual({
      kind: 'turn-on',
      org: a
    })
  })

  it('returns to Connect when the sign-in reached another organization, even with the row still expired', () => {
    const view = ready(signIn('A', true), signIn('B'))
    expect(botCliqSetupStep(view, linkedTo('B'), repair('A'))).toEqual({
      kind: 'connect',
      error: CLIQ_OTHER_ORG
    })
  })

  it('returns to Connect when the sign-in reached another organization and the row is gone', () => {
    expect(botCliqSetupStep(ready(signIn('B')), linkedTo('B'), repair('A'))).toEqual({
      kind: 'connect',
      error: CLIQ_OTHER_ORG
    })
  })
})
