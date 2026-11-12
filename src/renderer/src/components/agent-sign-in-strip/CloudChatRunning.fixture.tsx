// CHAT-BANNERS B2: a structured chat on Orca Cloud whose agent was running when its Orca-account
// sign-in expired: the strip at the top of the chat (expired → Renew; renewed → confirm and dismiss,
// no Restart), and the agent's 401 card, which on Orca Cloud points at Renew instead of the CLI login.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { NativeChatNoticeRow } from '../native-chat/messages/notices/NativeChatNoticeRow'
import {
  CloudAgentSignInStrip,
  cloudStripWidth,
  type CloudStripActions
} from './CloudAgentSignInStrip'
import { cloudChatRunningStripModel } from './cloud-running-strip-model'
import { CloudChatHostProvider } from './cloud-chat-sign-in-notice'

const noop = (): void => {}
const ACTIONS: CloudStripActions = {
  primary: noop,
  submitCode: noop,
  pasteCode: noop,
  useCode: noop,
  useApiKey: noop,
  cancel: noop
}
const ENV = 'fixture-cloud-env'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture seeds only the runtime environment the cloud check reads.
const store = {
  runtimeEnvironments: [{ id: ENV, name: 'Hello-World sandbox a1b2c3d4', source: 'ephemeral-vm' }]
} as unknown as Partial<AppState>

function Chat({
  phase,
  card,
  width
}: {
  phase: 'expired' | 'renewed' | null
  card: boolean
  width: number
}): React.JSX.Element {
  const fact = agentSessionFailureFact('notSignedIn', { account: 'system' })
  return (
    <CloudChatHostProvider target={{ kind: 'environment', environmentId: ENV }}>
      <div className="bg-background p-4">
        <div
          className="relative flex h-[380px] flex-col overflow-hidden rounded-md border border-border bg-chat-canvas"
          style={{ width }}
        >
          <div data-cloud-chat-banners="" className="shrink-0">
            {phase ? (
              <CloudAgentSignInStrip
                model={cloudChatRunningStripModel(
                  phase === 'expired'
                    ? { phase, agent: 'claude' }
                    : { phase, agent: 'claude', resumable: true },
                  translate
                )}
                prompt={null}
                width={cloudStripWidth(width)}
                actions={ACTIONS}
              />
            ) : null}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3 text-sm">
            <div className="self-end rounded-lg bg-muted px-3 py-2">Fix the flaky auth test</div>
            {card ? (
              <NativeChatNoticeRow
                agentName="Claude"
                block={{
                  type: 'text',
                  tone: 'failure',
                  ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
                }}
              />
            ) : null}
          </div>
          <div className="m-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            {translate(
              'components.native-chat.composer.placeholder',
              'Ask anything, @ to mention files, / for commands'
            )}
          </div>
        </div>
      </div>
    </CloudChatHostProvider>
  )
}

const fixture = (phase: 'expired' | 'renewed' | null, card: boolean, width = 760) =>
  defineFixture({
    width: width + 40,
    store,
    render: () => <Chat phase={phase} card={card} width={width} />
  })

/** RA-11 on a running structured chat: expired, with the agent's 401 card pointing at Renew. */
export const runningExpired = fixture('expired', true)
export const runningExpiredNarrow = fixture('expired', true, 420)
/** Renewed: confirms; the chat's next message uses it (no Restart), × dismisses. */
export const runningRenewed = fixture('renewed', false)
export const runningRenewedNarrow = fixture('renewed', false, 420)
/** The 401 card alone on Orca Cloud. */
export const signInCard = fixture(null, true)
