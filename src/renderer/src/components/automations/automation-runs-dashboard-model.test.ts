import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  buildAutomationRunsDashboardEntries,
  countAutomationRunOutcomes,
  filterAutomationRunsDashboardEntries,
  getAutomationRunsHostKey,
  getAutomationRunsScope
} from './automation-runs-dashboard-model'

function row(
  key: string,
  hostLabel: string,
  catalogRef: NonNullable<AutomationListRow['catalogRef']>
): AutomationListRow {
  return {
    key,
    hostLabel,
    catalogRef,
    usageSummary: null,
    automation: {
      id: key,
      name: `Automation ${key}`,
      executionTargetType: catalogRef.selector.kind === 'ssh' ? 'ssh' : 'local'
    } as Automation
  }
}

function run(
  id: string,
  automationId: string,
  scheduledFor: number,
  status: AutomationRun['status']
) {
  return { id, automationId, scheduledFor, status, title: `Run ${id}` } as AutomationRun
}

describe('automation runs dashboard model', () => {
  const local = row('local-row', 'Local Mac', {
    authority: { kind: 'desktop' },
    selector: { kind: 'self' }
  })
  const ssh = row('ssh-row', 'Build host', {
    authority: { kind: 'desktop' },
    selector: { kind: 'ssh', targetId: 'build' }
  })
  const runtime = row('runtime-row', 'Cloud runtime', {
    authority: { kind: 'runtime', environmentId: 'cloud' },
    selector: { kind: 'self' }
  })

  it('keeps local, SSH, and runtime hosts in one chronologically sorted list', () => {
    const entries = buildAutomationRunsDashboardEntries(
      [local, ssh, runtime],
      new Map([
        [local.key, [run('local', local.automation.id, 10, 'completed')]],
        [ssh.key, [run('ssh', ssh.automation.id, 30, 'dispatch_failed')]],
        [runtime.key, [run('runtime', runtime.automation.id, 20, 'completed')]]
      ])
    )

    expect(entries.map((entry) => entry.run.id)).toEqual(['ssh', 'runtime', 'local'])
    expect(getAutomationRunsScope(local)).toBe('local')
    expect(getAutomationRunsScope(ssh)).toBe('remote')
    expect(getAutomationRunsScope(runtime)).toBe('remote')
  })

  it('filters by host without splitting the dashboard into local and remote views', () => {
    const entries = buildAutomationRunsDashboardEntries(
      [local, ssh],
      new Map([
        [local.key, [run('local', local.automation.id, 10, 'completed')]],
        [ssh.key, [run('ssh', ssh.automation.id, 20, 'dispatch_failed')]]
      ])
    )

    expect(
      filterAutomationRunsDashboardEntries({
        entries,
        status: 'all',
        query: '',
        hostKeys: [getAutomationRunsHostKey(ssh)]
      }).map((entry) => entry.run.id)
    ).toEqual(['ssh'])
    expect(countAutomationRunOutcomes(entries, 30).successful7d).toBe(1)
  })

  it('keeps future-dated runs out of the outcome windows', () => {
    const entries = buildAutomationRunsDashboardEntries(
      [local, ssh],
      new Map([
        [local.key, [run('ahead', local.automation.id, 40, 'completed')]],
        [ssh.key, [run('ahead-failed', ssh.automation.id, 40, 'dispatch_failed')]]
      ])
    )

    expect(countAutomationRunOutcomes(entries, 30)).toEqual({
      successful24h: 0,
      failed24h: 0,
      successful7d: 0,
      failed7d: 0
    })
  })
})
