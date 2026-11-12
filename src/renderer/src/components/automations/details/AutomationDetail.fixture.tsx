import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AutomationDetail } from './AutomationDetail'
import { makeAutomation, makeRun, makeRunUsage } from '../automations-page-fixtures'

const NOW = Date.UTC(2026, 10, 9, 15, 0)
const HOUR = 60 * 60 * 1000

const PROMPT = `Scan open GitHub issues and pull requests labeled i18n in the repository.

For each item:
1. Check whether the strings it mentions are still missing from the locale files.
2. If the fix is a pure translation update, open a PR that adds the missing keys for every supported locale.
3. Otherwise leave a short comment summarizing what is missing and which files need changes.

Skip anything assigned to a human, and never close issues. Post a summary of what you changed in the automation run output.`

const automation = makeAutomation({
  name: 'GitHub i18n issue and PR scan',
  prompt: PROMPT,
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  nextRunAt: NOW + 18 * HOUR,
  precheck: { command: 'gh issue list --label i18n --json number', timeoutSeconds: 30 }
})

const noop = (): void => {}

function renderDetail(props: Partial<React.ComponentProps<typeof AutomationDetail>> = {}) {
  return (
    <div className="bg-background p-5 text-foreground">
      <AutomationDetail
        automation={automation}
        runs={[]}
        projectName="i18n Manager"
        workspaceName="i18n Manager"
        projectDefaultBaseRef="main"
        runNowAvailability={{ canRunNow: true, reason: 'available', message: null }}
        now={NOW}
        onRunNow={noop}
        onEdit={noop}
        onToggle={noop}
        onDelete={noop}
        {...props}
      />
    </div>
  )
}

export const neverRun = defineFixture({
  width: 1000,
  render: () => renderDetail()
})

export const healthy = defineFixture({
  width: 1000,
  render: () =>
    renderDetail({
      automation: { ...automation, lastRunAt: NOW - 6 * HOUR },
      runs: [
        makeRun({
          id: 'run-2',
          createdAt: NOW - 6 * HOUR,
          dispatchedAt: NOW - 6 * HOUR,
          usage: makeRunUsage({ totalTokens: 182_400, estimatedCostUsd: 1.42 })
        }),
        makeRun({
          id: 'run-1',
          createdAt: NOW - 30 * HOUR,
          dispatchedAt: NOW - 30 * HOUR,
          usage: makeRunUsage({ totalTokens: 96_100, estimatedCostUsd: 0.71 })
        })
      ]
    })
})

export const failed = defineFixture({
  width: 1000,
  render: () =>
    renderDetail({
      automation: { ...automation, lastRunAt: NOW - 2 * HOUR },
      runs: [
        makeRun({
          id: 'run-3',
          status: 'dispatch_failed',
          error: 'The agent CLI exited before the session started.',
          createdAt: NOW - 2 * HOUR,
          dispatchedAt: null,
          startedAt: NOW - 2 * HOUR
        })
      ]
    })
})

export const paused = defineFixture({
  width: 720,
  render: () =>
    renderDetail({
      automation: { ...automation, enabled: false, prompt: 'Run the nightly sweep.' }
    })
})

export const createdByPlugin = defineFixture({
  width: 1000,
  render: () =>
    renderDetail({
      automation: {
        ...automation,
        name: 'Nightly dependency check',
        prompt: 'Check for outdated dependencies and open a PR with safe upgrades.',
        precheck: null,
        createdBy: { kind: 'plugin', pluginKey: 'acme.deps', name: 'Dependency Watch' }
      }
    })
})

export const createdByEndedPlugin = defineFixture({
  width: 1000,
  render: () =>
    renderDetail({
      automation: {
        ...automation,
        name: 'Nightly dependency check',
        prompt: 'Check for outdated dependencies and open a PR with safe upgrades.',
        precheck: null,
        enabled: false,
        createdBy: {
          kind: 'plugin',
          pluginKey: 'acme.deps',
          name: 'Dependency Watch',
          endedAt: Date.UTC(2026, 10, 9, 12, 0)
        }
      }
    })
})
