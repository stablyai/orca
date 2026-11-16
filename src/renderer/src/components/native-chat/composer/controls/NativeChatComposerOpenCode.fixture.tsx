import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  createStructuredAgentSessionOptionState,
  applyStructuredAgentSessionOptions
} from '../../../../../../shared/agent-session/options/structured-agent-session-options'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session/options/agent-session-option-catalog'
import { structuredAgentSessionOptionSnapshot } from '../../../../../../shared/agent-session/options/view/structured-agent-session-option-snapshot'
import type { SessionOptionsSurface } from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatComposerActions } from './NativeChatComposerActions'

function openCodeFixture(agent: string, plan: boolean, width: number) {
  const catalog = getAgentSessionOptionCatalog('opencode2')!
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('opencode2', catalog),
    catalog,
    {
      models: [{ id: 'provider/model', label: 'Model', isDefault: false, efforts: [] }],
      interactionModes: ['default', 'plan'],
      current: {
        model: 'provider/model',
        interactionMode: plan ? 'plan' : 'default',
        acceptedInputSources: plan ? { interactionMode: 'saved' } : {},
        reportedAgent: { id: agent.toLowerCase(), name: agent }
      }
    }
  )
  const snapshot = structuredAgentSessionOptionSnapshot(state)
  const surface: SessionOptionsSurface = {
    getSnapshot: () => snapshot,
    setOption: async () => ({ snapshot }),
    invokeAction: async () => ({ snapshot }),
    subscribe: () => () => {}
  }
  return defineFixture({
    width,
    render: () => (
      <div
        className="native-chat-appearance box-border flex flex-col justify-end bg-background p-4"
        style={{ height: width === 390 ? 844 : 900 }}
      >
        <div className="rounded-xl border p-3">
          <p className="mb-4 text-sm text-chat-foreground-faint">Describe the next step…</p>
          <NativeChatComposerActions
            attachDisabled={false}
            dictationDisabled={false}
            sendDisabled={false}
            isWorking={false}
            isDictating={false}
            isDictationHoldMode={false}
            onAttach={() => {}}
            onDictationToggle={() => {}}
            onDictationHoldStart={() => {}}
            onDictationHoldEnd={() => {}}
            onSend={() => {}}
            sessionOptionsSurface={surface}
            sessionOptionsSnapshot={snapshot}
            agent="opencode2"
          />
        </div>
      </div>
    )
  })
}

export const buildDesktop = openCodeFixture('Build', false, 1440)
export const planDesktop = openCodeFixture('Plan', true, 1440)
export const reviewerDesktop = openCodeFixture('Reviewer', false, 1440)
export const nextPlanDesktop = openCodeFixture('Build', true, 1440)
export const buildMobile = openCodeFixture('Build', false, 390)
export const planMobile = openCodeFixture('Plan', true, 390)
export const reviewerMobile = openCodeFixture('Reviewer', false, 390)
export const nextPlanMobile = openCodeFixture('Build', true, 390)
