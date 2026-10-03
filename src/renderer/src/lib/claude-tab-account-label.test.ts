import { describe, expect, it } from 'vitest'
import { claudeTabAccountLabel } from './claude-tab-account-label'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { ClaudeManagedAccountSummary } from '../../../shared/managed-account-types'

function account(
  overrides: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id: 'acct-1',
    email: 'dev@example.com',
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...overrides
  }
}

function launchConfig(claudeAccountId?: string): SleepingAgentLaunchConfig {
  return {
    agentArgs: '',
    agentEnv: {},
    ...(claudeAccountId ? { claudeAccountId } : {})
  }
}

function fromLaunch(claudeAccountId?: string) {
  return {
    statusAccountId: undefined,
    launchConfig: launchConfig(claudeAccountId)
  }
}

describe('claudeTabAccountLabel', () => {
  it('returns the email for a pinned account id', () => {
    const accounts = [account({ id: 'acct-1', email: 'dev@example.com' })]
    expect(
      claudeTabAccountLabel(fromLaunch('acct-1'), accounts, {
        pinningUnsupported: false
      })
    ).toBe('dev@example.com')
  })

  it('labels a restored tab from main after a restart emptied the launch records', () => {
    const accounts = [account({ id: 'acct-1', email: 'dev@example.com' })]
    expect(
      claudeTabAccountLabel({ statusAccountId: 'acct-1', launchConfig: undefined }, accounts, {
        pinningUnsupported: false
      })
    ).toBe('dev@example.com')
  })

  it("prefers main's pinned account over this renderer's launch record", () => {
    const accounts = [
      account({ id: 'acct-1', email: 'dev@example.com' }),
      account({ id: 'acct-2', email: 'other@example.com' })
    ]
    expect(
      claudeTabAccountLabel(
        { statusAccountId: 'acct-2', launchConfig: launchConfig('acct-1') },
        accounts,
        { pinningUnsupported: false }
      )
    ).toBe('other@example.com')
  })

  it('returns null for an unknown account id', () => {
    const accounts = [account({ id: 'acct-1' })]
    expect(
      claudeTabAccountLabel(fromLaunch('acct-missing'), accounts, {
        pinningUnsupported: false
      })
    ).toBeNull()
  })

  it('returns null for the active sentinel and when nothing names an account', () => {
    const accounts = [account({ id: 'acct-1' })]
    expect(
      claudeTabAccountLabel(fromLaunch(ACTIVE_CLAUDE_ACCOUNT), accounts, {
        pinningUnsupported: false
      })
    ).toBeNull()
    expect(
      claudeTabAccountLabel({ statusAccountId: undefined, launchConfig: undefined }, accounts, {
        pinningUnsupported: false
      })
    ).toBeNull()
  })

  it('returns null for an SSH or WSL repo even with a pinned account id', () => {
    const accounts = [account({ id: 'acct-1' })]
    expect(
      claudeTabAccountLabel(
        { statusAccountId: 'acct-1', launchConfig: launchConfig('acct-1') },
        accounts,
        {
          pinningUnsupported: true
        }
      )
    ).toBeNull()
  })
})
