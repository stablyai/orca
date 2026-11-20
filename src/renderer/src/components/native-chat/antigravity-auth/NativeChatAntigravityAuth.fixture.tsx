import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { NativeChatNoticeRow } from '../messages/notices/NativeChatNoticeRow'
import {
  NativeChatAntigravityAuthContext,
  type NativeChatAntigravityAuth
} from './native-chat-antigravity-auth'
import { NativeChatAntigravityAuthChip } from './NativeChatAntigravityAuthChip'

const FOUND: AntigravityChatAuthDetection = {
  method: 'oauth-personal',
  googleSignIn: { personal: false, business: false },
  apiKey: { available: true, source: 'environment' },
  adc: { available: true, project: 'acme-dev' },
  liveChats: 0,
  agyVersion: '1.5.13'
}
const auth = (
  detection: AntigravityChatAuthDetection,
  ownHome = false
): NativeChatAntigravityAuth => ({
  host: { kind: 'local' },
  ownHome,
  managedVersion: '1.5.13',
  orcasAgy: false,
  programPending: false,
  detection,
  keyAndAdc: true,
  switching: null,
  switchTo: () => undefined,
  openSettings: () => undefined,
  refresh: () => undefined
})

function ChipMenu(props: { auth: NativeChatAntigravityAuth }) {
  return (
    <NativeChatAntigravityAuthContext value={props.auth}>
      <div className="flex h-80 items-end justify-end p-4 text-2xs text-chat-foreground-faint">
        <NativeChatAntigravityAuthChip textClassName="text-2xs whitespace-nowrap" />
      </div>
    </NativeChatAntigravityAuthContext>
  )
}

async function openChip(frame: HTMLElement): Promise<void> {
  const trigger = frame.querySelector<HTMLElement>('[data-antigravity-auth-chip]')
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  await new Promise((resolve) => setTimeout(resolve, 200))
}

export const chipMenu = defineFixture({
  width: 720,
  interact: openChip,
  render: () => <ChipMenu auth={auth({ ...FOUND, method: 'gemini-api-key' })} />
})

export const chipMenuOnAgy = defineFixture({
  width: 720,
  interact: openChip,
  render: () => <ChipMenu auth={auth(FOUND, true)} />
})

export const failureNotice = defineFixture({
  width: 640,
  render: () => (
    <NativeChatAntigravityAuthContext value={auth(FOUND)}>
      <div className="space-y-3 p-4">
        <NativeChatNoticeRow
          agentName="Antigravity"
          block={{
            type: 'text',
            tone: 'error',
            text: 'Request failed: 403 PERMISSION_DENIED (SUBSCRIPTION_REQUIRED)'
          }}
        />
        <NativeChatNoticeRow
          agentName="Antigravity"
          block={{
            type: 'text',
            tone: 'error',
            ...agentSessionFailureWords(
              agentSessionFailureFact('notSignedIn', { account: 'system' }),
              { agentName: 'Antigravity', surface: 'row' }
            )
          }}
        />
      </div>
    </NativeChatAntigravityAuthContext>
  )
})
