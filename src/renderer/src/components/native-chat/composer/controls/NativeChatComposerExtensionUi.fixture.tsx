import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatComposerExtensionUi } from './NativeChatComposerExtensionUi'
import {
  AGENT_SESSION_EXTENSION_STATUS_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION,
  agentSessionExtensionStripRows
} from '../../../../../../shared/agent-session/view/agent-session-extension-ui'

const rows = agentSessionExtensionStripRows([
  {
    itemId: 'todos',
    revision: 2,
    body: {
      kind: 'status',
      text: '── Todos ──\n[x] Read the issue\n[ ] Render Pi widgets\n[ ] Run check:changed',
      presentation: AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION
    },
    sequence: 1,
    observedAt: 1,
    turnScope: { kind: 'thread' }
  },
  {
    itemId: 'lens',
    revision: 3,
    body: {
      kind: 'status',
      text: 'pi-lens · 2 diagnostics',
      presentation: AGENT_SESSION_EXTENSION_STATUS_PRESENTATION
    },
    sequence: 2,
    observedAt: 2,
    turnScope: { kind: 'thread' }
  }
])

/** A Pi extension's pinned todo widget and status line on the composer's top edge. */
export const todos = defineFixture({
  width: 640,
  render: () => (
    <div className="bg-background p-4">
      <NativeChatComposerExtensionUi rows={rows} placement="above" />
    </div>
  )
})
