import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  automationRunMessageBody,
  buildAutomationRunPreamble
} from '../../../../shared/automation-run-preamble'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'

const task =
  'Write the weekly brief for the Orca team: merged PRs, open PRs older than a week, and Linear issues in Triage. Attach it as an HTML report.'
const markdown = `${buildAutomationRunPreamble('orca')}${task}`
const message: NativeChatMessage = {
  id: 'automation',
  role: 'user',
  source: 'transcript',
  blocks: automationRunMessageBody(task, buildAutomationRunPreamble('orca').trimEnd()).blocks,
  timestamp: 1_800_000_000_000
}
const render = () => (
  <div className="native-chat-appearance bg-background p-6">
    <NativeChatUserMessageRow
      message={message}
      markdown={markdown}
      prose={message.blocks}
      rowRef={{ current: null }}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  </div>
)

export const collapsed = defineFixture({ width: 760, render })
export const expanded = defineFixture({
  width: 760,
  render,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
  }
})
