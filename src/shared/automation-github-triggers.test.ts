import { describe, expect, it } from 'vitest'
import type { Automation } from './automations/automation-definition'
import {
  assertAutomationEventTriggers,
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from './automation-event-triggers'
import {
  needsGitHub2,
  needsWorkflows,
  WORKFLOW_WAIT_NEEDS_DEADLINE
} from './automation-github-triggers'

const automation = (on: AutomationEventTrigger[]) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only bot, on, once and the schedule, all set here.
  ({
    id: 'auto-1',
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
    on,
    ...EVENT_ONLY_SCHEDULE
  }) as Automation
const check = (trigger: AutomationEventTrigger) => () =>
  assertAutomationEventTriggers(automation([trigger]))

describe("GitHub's newer events on a rule", () => {
  it("follow one pull request's state with subject= and no from=", () => {
    for (const event of ['ci_passed', 'pr_conflicted'] as const) {
      expect(check({ id: 'on-1', source: 'github', event, subject: 'acme/web#4' })).not.toThrow()
      expect(check({ id: 'on-1', source: 'github', event, in: ['acme/web'] })).toThrow(
        `github.${event} follows one pull request: name it with subject=<owner/repo#n>.`
      )
      expect(
        check({ id: 'on-1', source: 'github', event, subject: 'acme/web#4', from: ['7'] })
      ).toThrow('leave out from=')
    }
  })

  it('take label= on github.labeled only', () => {
    expect(check({ id: 'on-1', source: 'github', event: 'labeled', label: 'bug' })).not.toThrow()
    expect(check({ id: 'on-1', source: 'github', event: 'labeled' })).not.toThrow()
    expect(check({ id: 'on-1', source: 'github', event: 'comment', label: 'bug' })).toThrow(
      'label= is for github.labeled only, not github.comment.'
    )
  })

  it('need a cloud that sends them, as label= does', () => {
    expect(needsGitHub2({ id: 'a', source: 'github', event: 'security_alert' })).toBe(true)
    expect(needsGitHub2({ id: 'a', source: 'github', event: 'ci_failed' })).toBe(false)
    expect(needsGitHub2({ id: 'a', source: 'github', event: 'labeled' })).toBe(true)
    expect(needsGitHub2({ id: 'a', source: 'slack', event: 'message' })).toBe(false)
  })
})

describe('github.workflow_finished on a rule', () => {
  const run = (fields: Partial<AutomationEventTrigger> = {}) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a GitHub rule with the run filter's fields, as the CLI writes it.
    ({
      id: 'on-1',
      source: 'github',
      event: 'workflow_finished',
      in: ['github:42:500'],
      run: '43633379052',
      ...fields
    }) as AutomationEventTrigger
  const wait = (trigger: AutomationEventTrigger, once?: Automation['once']) => () =>
    assertAutomationEventTriggers({
      ...automation([trigger]),
      createdAt: 1_000,
      ...(once ? { once } : {})
    })

  it('is a wait with a deadline, on save and on every edit', () => {
    expect(wait(run(), { by: 60_000 })).not.toThrow()
    expect(wait(run())).toThrow(WORKFLOW_WAIT_NEEDS_DEADLINE)
    // An edit that drops --by is checked as the whole automation it leaves.
    expect(wait(run(), {})).toThrow(WORKFLOW_WAIT_NEEDS_DEADLINE)
  })

  it('names one run, in one repo, and takes only contains= beside it', () => {
    const by = { by: 60_000 }
    expect(wait(run({ textContains: '[conclusion=failure]' }), by)).not.toThrow()
    for (const missing of [{ run: undefined }, { run: 'abc' }, { in: undefined }]) {
      expect(wait(run(missing), by)).toThrow('waits on one run: name it with run=')
    }
    expect(wait(run({ in: ['github:42:500', 'github:42:501'] }), by)).toThrow('waits on one run')
    for (const extra of [
      { subject: 'acme/web#4' },
      { from: ['7'] },
      { fromOwner: true as const }
    ]) {
      expect(wait(run(extra), by)).toThrow('takes only run= and contains=')
    }
  })

  it('requires a resolved repo ref through the shared save validation', () => {
    for (const place of [
      'github:42:workspace',
      'github:42:500:8',
      'github:42:user:7',
      'github:42:abc',
      'acme/web'
    ]) {
      expect(wait(run({ in: [place] }), { by: 60_000 })).toThrow('repo ref')
    }
    expect(wait(run({ in: ['github:42:500'] }), { by: 60_000 })).not.toThrow()
  })

  it('takes run= on github.workflow_finished only', () => {
    expect(check({ id: 'on-1', source: 'github', event: 'ci_failed', run: '42' })).toThrow(
      'run= is for github.workflow_finished only, not github.ci_failed.'
    )
  })

  it('needs a cloud that sends it', () => {
    expect(needsWorkflows(run())).toBe(true)
    expect(needsWorkflows({ id: 'a', source: 'github', event: 'ci_failed' })).toBe(false)
    expect(needsGitHub2(run())).toBe(false)
  })
})
