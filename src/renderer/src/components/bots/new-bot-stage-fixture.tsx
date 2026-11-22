import { useState } from 'react'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { useAppStore } from '@/store'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { PortalContainerContext } from '../ui/portal-container-context'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { BotProposal } from '../../../../shared/bots/bot-proposal'
import type { BotShareReview } from '../../../../shared/bots/bot-share-received'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { NewBotDialog } from './NewBotDialog'

// Review shots at a 340 and a 480 px dialog. The dialog is fixed, so it portals into a transformed box
// that wide (plus its 1rem margins) instead of the page's wide viewport.
export function NewBotFixtureStage({
  width,
  nudge,
  proposal,
  height = 620,
  link,
  offerHostId,
  reopen = false
}: {
  width: 340 | 480
  nudge?: boolean
  proposal?: BotProposal
  height?: number
  /** Opened from a reviewed link, as the link flow opens it. */
  link?: BotShareReview
  offerHostId?: ExecutionHostId
  reopen?: boolean
}): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(true)
  return (
    <div
      ref={setBox}
      className="relative translate-x-0 bg-background"
      style={{ width: width + 32, height }}
    >
      {reopen ? (
        <button type="button" hidden={open} onClick={() => setOpen(true)}>
          Reopen New bot
        </button>
      ) : null}
      {box ? (
        <PortalContainerContext.Provider value={box}>
          <NewBotDialog
            open={open}
            onOpenChange={reopen ? setOpen : () => {}}
            onImport={nudge ? () => {} : undefined}
            proposal={proposal}
            offerHostId={offerHostId}
            {...(link
              ? { fromShare: { review: link, toolIds: [], onBack: () => {}, onMoved: () => {} } }
              : {})}
          />
        </PortalContainerContext.Provider>
      ) : null}
    </div>
  )
}

export const LONG_FIXTURE_COMPUTER = 'build-runner-02.example.test'

export const seedNewBotFixture =
  (computer?: string, agents: TuiAgent[] = ['claude', 'codex']) =>
  (): void => {
    stubBots([])
    setLocalRuntimeCapabilitiesForTests(
      agents.length ? [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] : []
    )
    useAppStore.setState((state) => ({
      detectedAgentIds: agents,
      localDetectedAgentIdsByContext: {
        host: agents,
        'host\u0000all-agents': agents
      },
      ensureDetectedAgents: async () => agents,
      isDetectingAgents: false,
      settings: state.settings && {
        ...state.settings,
        hostSettingOverrides: computer ? { local: { displayLabel: computer } } : {}
      }
    }))
  }

export const newBotFixture = (width: 340 | 480, computer?: string) => ({
  width: width + 32,
  setup: seedNewBotFixture(computer),
  render: () => <NewBotFixtureStage width={width} />
})

// Types into the controlled fields the way a person would, so React sees the change.
export const typeInto = (selector: string, text: string) => async (): Promise<void> => {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (!field) {
    return
  }
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Reflect.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
}
