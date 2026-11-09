import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AgentSignInGate, AgentSignInGateView } from '@/lib/agent-sign-in/agent-sign-in-gate'
import { AgentSignInCard, type AgentSignInCardActions } from './AgentSignInCard'
import { AgentSignInOverlay } from './AgentSignInOverlay'

const actions: AgentSignInCardActions = {
  signIn: () => {},
  retry: () => {},
  useCode: () => {},
  submitCode: () => {},
  openLink: () => {},
  copyText: () => {},
  cancel: () => {},
  skip: () => {}
}

const PROMPT = 'Fix the flaky retry test in api/client.test.ts and explain the root cause'

function gate(
  view: AgentSignInGateView,
  overrides: Partial<AgentSignInGate> = {}
): AgentSignInGate {
  return {
    key: 'fixture',
    environmentId: 'env-m4air',
    hostLabel: 'm4air',
    agent: 'claude',
    prompt: PROMPT,
    codeOnly: false,
    view,
    ...overrides
  }
}

function Pane({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="relative h-[380px] bg-background font-mono text-xs text-muted-foreground/60">
      <div className="p-3">nw@m4air ~/src/api (fix/flaky-retry) $</div>
      <AgentSignInOverlay>{children}</AgentSignInOverlay>
    </div>
  )
}

const shot = (g: AgentSignInGate) =>
  defineFixture({
    width: 640,
    render: () => (
      <Pane>
        <AgentSignInCard gate={g} actions={actions} />
      </Pane>
    )
  })

export const need = shot(gate({ step: 'need' }))
export const needCodex = shot(gate({ step: 'need' }, { agent: 'codex' }))
export const starting = shot(gate({ step: 'starting' }))
export const waiting = shot(gate({ step: 'waiting', url: 'https://claude.ai/oauth/authorize' }))
export const waitingCodex = shot(
  gate({ step: 'waiting', url: 'https://auth.openai.com/oauth/authorize' }, { agent: 'codex' })
)
export const signedIn = shot(gate({ step: 'signed', email: 'nw@stably.ai' }))
export const portBusy = shot(
  gate(
    { step: 'error', kind: 'port_busy', message: 'Port 1455 is busy.', port: 1455 },
    { agent: 'codex' }
  )
)
export const timedOut = shot(gate({ step: 'error', kind: 'timeout', message: 'timed out' }))
export const declined = shot(gate({ step: 'error', kind: 'declined', message: 'access_denied' }))
export const offline = shot(gate({ step: 'error', kind: 'offline', message: 'transport lost' }))
export const failed = shot(
  gate({
    step: 'error',
    kind: 'failed',
    message: 'Claude command failed: OAuth error: invalid_grant'
  })
)
export const pasteCode = shot(
  gate({
    step: 'paste',
    url: 'https://claude.ai/oauth/authorize?code=true',
    submitting: false,
    refusal: null
  })
)
export const pasteRefused = shot(
  gate({
    step: 'paste',
    url: 'https://claude.ai/oauth/authorize?code=true',
    submitting: false,
    refusal: 'Claude did not accept that code. Start the sign-in again.'
  })
)
export const deviceCode = shot(
  gate(
    { step: 'device', url: 'https://auth.openai.com/codex/device', userCode: 'K7PQ-2HXM' },
    { agent: 'codex' }
  )
)
export const olderHost = shot(gate({ step: 'need' }, { codeOnly: true }))
export const noPrompt = shot(gate({ step: 'need' }, { prompt: null, hostLabel: 'feature-x' }))
