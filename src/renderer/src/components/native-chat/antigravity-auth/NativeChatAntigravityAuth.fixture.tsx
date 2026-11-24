import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { ANTIGRAVITY_SUBSCRIPTION_REQUIRED } from '../../../../../shared/agent-accounts/antigravity/antigravity-sign-in-sentences'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { NativeChatSignInStrip } from '../host-access/NativeChatSignInStrip'
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
const NOTHING: AntigravityChatAuthDetection = {
  ...FOUND,
  apiKey: { available: false, source: null },
  adc: { available: false, project: null }
}

const auth = (
  detection: AntigravityChatAuthDetection,
  agy: NativeChatAntigravityAuth['agy'] = 'yours'
): NativeChatAntigravityAuth => ({
  host: { kind: 'local' },
  agy,
  managedVersion: agy === 'orcas' ? '1.5.16' : null,
  detection,
  keyAndAdc: true,
  switching: null,
  switchTo: () => undefined,
  signInWithGoogle: () => undefined,
  openSettings: () => undefined,
  refresh: () => undefined
})

const view = (error: string | null = null) => ({
  status: 'known' as const,
  flow: null,
  auth: 'signedOut' as const,
  error,
  openFailed: false,
  retryIntent: 'signIn' as const
})

function Strip(props: { detection: AntigravityChatAuthDetection; error?: string }) {
  return (
    <NativeChatAntigravityAuthContext value={auth(props.detection)}>
      <div className="p-4">
        <NativeChatSignInStrip
          agentLabel="Antigravity"
          state={{
            prompt: props.error ? 'failed' : 'signedOut',
            view: view(props.error ?? null),
            agent: 'antigravity',
            host: { kind: 'local' }
          }}
        />
      </div>
    </NativeChatAntigravityAuthContext>
  )
}

export const stripDetected = defineFixture({
  width: 720,
  render: () => <Strip detection={FOUND} />
})

export const stripNothingDetected = defineFixture({
  width: 720,
  render: () => <Strip detection={NOTHING} />
})

export const stripNoSubscription = defineFixture({
  width: 720,
  render: () => <Strip detection={FOUND} error={ANTIGRAVITY_SUBSCRIPTION_REQUIRED} />
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
  render: () => (
    <ChipMenu
      auth={auth({
        ...FOUND,
        method: 'gemini-api-key',
        googleSignIn: { personal: true, business: false }
      })}
    />
  )
})

export const chipMenuOrcasAgy = defineFixture({
  width: 720,
  interact: openChip,
  render: () => <ChipMenu auth={auth({ ...FOUND, agyVersion: null }, 'orcas')} />
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
              agentSessionFailureFact('notSignedIn', { account: 'managed' }),
              { agentName: 'Antigravity', surface: 'row' }
            )
          }}
        />
      </div>
    </NativeChatAntigravityAuthContext>
  )
})
