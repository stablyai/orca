import { defineFixture } from '../../component-fixtures/component-fixture'
import type { OrchestrationCrewSnapshot } from '../../../../shared/orchestration-crew'
import { CrewPanelContent } from './OrchestrationCrewPanel'

const snapshot = (name: string): OrchestrationCrewSnapshot => ({
  status: 'ok',
  sections: {
    managedBy: [],
    talkingWith: [],
    managing: [
      {
        partyKey: name,
        role: 'worker',
        label: name,
        agentKind: 'codex',
        status: 'working',
        sendAddress: `term_${name}`,
        task: { title: 'Review the result', state: 'active' }
      }
    ]
  }
})

// Orca-specific Crew overlay: actual menu/pane owner with controlled content and clipboard IO.
export const keyboardPanes = defineFixture({
  width: 760,
  setup: () => {
    window.api.ui.writeTerminalClipboardText = async () => {}
  },
  render: () => (
    <div className="grid h-96 grid-cols-2 gap-2">
      <div className="pane relative overflow-hidden" data-testid="crew-pane-a">
        <label>
          Terminal destination A
          <input aria-label="Terminal destination A" />
        </label>
        <CrewPanelContent target={{ kind: 'local' }} party="term_a" snapshot={snapshot('Alpha')} />
      </div>
      <div data-native-chat-root className="relative overflow-hidden" data-testid="crew-pane-b">
        <label>
          Native destination B
          <input aria-label="Native destination B" />
        </label>
        <CrewPanelContent target={{ kind: 'local' }} party="term_b" snapshot={snapshot('Beta')} />
      </div>
    </div>
  )
})
