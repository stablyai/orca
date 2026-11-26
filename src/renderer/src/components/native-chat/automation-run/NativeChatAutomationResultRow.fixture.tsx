import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  makeAutomationResultNote,
  type AutomationResultNote
} from '../../../../../shared/bots/bot-automation-result-note'
import {
  NativeChatDisclosureContext,
  type NativeChatDisclosureStore
} from '../messages/disclosure/native-chat-disclosure-store'
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

// Every row open, so its read line shows: unread, told with a later message, cleared.
const ALL_OPEN: NativeChatDisclosureStore = {
  read: () => true,
  write: () => {},
  toolRunMeasurements: new Map()
}
const finished = {
  outcome: 'finished' as const,
  result: 'Three advisories and two stale branches.'
}

export const opened = defineFixture({
  width: 560,
  render: () => (
    <NativeChatDisclosureContext.Provider value={ALL_OPEN}>
      <div className="space-y-1">
        <NativeChatAutomationResultRow note={note({ ...finished, runId: 'run-unread' })} />
        <NativeChatAutomationResultRow
          note={note({ ...finished, runId: 'run-read', readWith: 'message-1' })}
        />
        <NativeChatAutomationResultRow note={note({ ...finished, runId: 'run-cleared' })} cleared />
      </div>
    </NativeChatDisclosureContext.Provider>
  )
})
