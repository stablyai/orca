import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  makeAutomationResultNote,
  type AutomationResultNote
} from '../../../../../shared/bots/bot-automation-result-note'
import { NativeChatAutomationResultRow } from './NativeChatAutomationResultRow'

const AT = new Date(2026, 10, 9, 6, 19).getTime()

function note(overrides: Partial<AutomationResultNote>): AutomationResultNote {
  return {
    ...makeAutomationResultNote({
      automationId: 'auto-1',
      automationName: 'GitHub i18n issue and PR scan',
      botName: 'Atlas',
      runId: 'run-1',
      trigger: 'schedule',
      outcome: 'couldNotFinish',
      result: 'The scan stopped before it reached the pull requests.',
      at: AT
    }),
    ...overrides
  }
}

const rows = (
  <div className="space-y-1">
    <NativeChatAutomationResultRow note={note({})} />
    <NativeChatAutomationResultRow note={note({ result: '' })} />
    <NativeChatAutomationResultRow
      note={note({ outcome: 'finished', trigger: 'event', result: 'Nothing to report' })}
    />
    <NativeChatAutomationResultRow
      note={note({
        outcome: 'finished',
        automationName: 'Weekly dependency, security advisory and stale branch report',
        result: 'Three advisories and two stale branches.'
      })}
    />
  </div>
)

export const states = defineFixture({ width: 560, render: () => rows })
export const narrow = defineFixture({ width: 300, render: () => rows })
