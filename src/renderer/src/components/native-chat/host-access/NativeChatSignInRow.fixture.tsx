import type { CSSProperties } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from '../composer/controls/NativeChatComposerNotices'
import { structuredSessionNotices } from '../messages/notices/native-chat-structured-session-notices'
import { NativeChatNoticeRow } from '../messages/notices/NativeChatNoticeRow'
import { MessageRow } from '../messages/rows/NativeChatMessageRow'
import { NativeChatHostSetupContext, type NativeChatHostSetup } from './native-chat-host-setup'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'

type FixtureAgent = 'antigravity' | 'claude' | 'codex' | 'opencode'
type FixtureState = 'signedOut' | 'signingIn' | 'signedIn'

const AGENTS: Record<
  FixtureAgent,
  {
    label: string
    account?: AgentSessionAccountKind
    loginCommand?: string
    /** Only Claude's in-app sign-in reports signed in; Antigravity's opens Settings. */
    states: readonly FixtureState[]
    /** What an older host still sends; desktop says the short sentence from the failure fact. */
    oldSentence: string
  }
> = {
  antigravity: {
    label: 'Antigravity',
    states: ['signedOut'],
    oldSentence:
      "Antigravity isn't signed in. Sign in under Settings → Accounts → Antigravity. Then send your message again."
  },
  claude: {
    label: 'Claude',
    account: 'managed',
    states: ['signedOut', 'signingIn', 'signedIn'],
    oldSentence: "This Claude account isn't signed in. Sign in again in Claude Accounts settings."
  },
  codex: {
    label: 'Codex',
    account: 'system',
    loginCommand: 'codex login',
    states: ['signedOut', 'signingIn'],
    oldSentence: "Codex isn't signed in. Run `codex login`."
  },
  opencode: {
    label: 'OpenCode',
    loginCommand: 'opencode auth login',
    states: ['signedOut', 'signingIn'],
    oldSentence: 'Sign in to OpenCode with `opencode auth login` on the computer running this chat.'
  }
}

const AGENT_IDS: readonly FixtureAgent[] = ['antigravity', 'claude', 'codex', 'opencode']

function setupFor(agent: FixtureAgent, state: FixtureState): NativeChatHostSetup {
  const { loginCommand } = AGENTS[agent]
  return {
    signIn:
      agent === 'antigravity'
        ? null
        : {
            signingIn: state === 'signingIn',
            signedIn: state === 'signedIn',
            signIn: () => {},
            ...(loginCommand ? { loginCommand } : {})
          },
    install: null,
    host: { kind: 'local' }
  }
}

// Built once: a context value made during render would be a new object every time.
const SETUPS = new Map(
  AGENT_IDS.flatMap((agent) =>
    (['signedOut', 'signingIn', 'signedIn'] as const).map((state) => {
      const setup = setupFor(agent, state)
      return [
        `${agent}:${state}`,
        {
          alone: setup,
          both: { ...setup, signInInComposer: true },
          // No failure row is unresolved: a later successful turn resolved them all.
          resolved: { ...setup, unresolvedFailureRows: new Set<string>() }
        }
      ]
    })
  )
)

function setupsFor(agent: FixtureAgent, state: FixtureState) {
  return SETUPS.get(`${agent}:${state}`)!
}

function Composer({ agent, setup }: { agent: FixtureAgent; setup: NativeChatHostSetup }) {
  const { label, account } = AGENTS[agent]
  return (
    <NativeChatComposerNotices
      notices={structuredSessionNotices({
        launch: {
          lifecycle: 'failed',
          failure: {
            kind: 'refused',
            code: 'agent_session_operation_invalid',
            details: { reason: 'notSignedIn', ...(account ? { account } : {}) }
          },
          retry: () => {}
        },
        agentLabel: label,
        sessionError: null,
        composerError: null,
        setup
      })}
    />
  )
}

function FailedMessage({ agent }: { agent: FixtureAgent }) {
  const { label, account, oldSentence } = AGENTS[agent]
  return (
    <MessageRow
      agentName={label}
      message={{
        id: `failed-${agent}`,
        role: 'user',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Draft the launch post for tomorrow' }]
      }}
      deliveryNotice={{
        text: oldSentence,
        failureKind: 'notSignedIn',
        signIn: { agentName: label, ...(account ? { account } : {}) }
      }}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
    />
  )
}

const SURFACES = ['Above composer', 'Failed message', 'Both'] as const

function Scene({ agent, fontSize }: { agent: FixtureAgent; fontSize?: number }) {
  const style: (CSSProperties & Record<`--${string}`, string>) | undefined = fontSize
    ? {
        '--chat-font-size': `${fontSize}px`,
        '--chat-ui-font-size': `${fontSize}px`
      }
    : undefined
  return (
    <div className="native-chat-appearance space-y-5 p-3" style={style}>
      {AGENTS[agent].states.map((state) => {
        const setups = setupsFor(agent, state)
        const setup = setups.alone
        return (
          <section key={state} className="space-y-3">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {AGENTS[agent].label} · {state}
            </h3>
            {SURFACES.map((surface) => (
              <div key={surface} className="space-y-2">
                <p className="text-2xs text-muted-foreground">{surface}</p>
                {surface === 'Above composer' ? (
                  <Composer agent={agent} setup={setup} />
                ) : (
                  <NativeChatHostSetupContext.Provider
                    value={surface === 'Both' ? setups.both : setup}
                  >
                    <FailedMessage agent={agent} />
                  </NativeChatHostSetupContext.Provider>
                )}
                {surface === 'Both' ? <Composer agent={agent} setup={setup} /> : null}
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

export const antigravity520 = defineFixture({
  width: 520,
  render: () => <Scene agent="antigravity" />
})
export const claude520 = defineFixture({ width: 520, render: () => <Scene agent="claude" /> })
export const codex520 = defineFixture({ width: 520, render: () => <Scene agent="codex" /> })
export const opencode520 = defineFixture({ width: 520, render: () => <Scene agent="opencode" /> })

export const antigravity300 = defineFixture({
  width: 300,
  render: () => <Scene agent="antigravity" />
})
export const claude300 = defineFixture({ width: 300, render: () => <Scene agent="claude" /> })
export const codex300 = defineFixture({ width: 300, render: () => <Scene agent="codex" /> })
export const opencode300 = defineFixture({ width: 300, render: () => <Scene agent="opencode" /> })

export const antigravity300Text15 = defineFixture({
  width: 300,
  render: () => <Scene agent="antigravity" fontSize={15} />
})
export const claude300Text15 = defineFixture({
  width: 300,
  render: () => <Scene agent="claude" fontSize={15} />
})
export const codex300Text15 = defineFixture({
  width: 300,
  render: () => <Scene agent="codex" fontSize={15} />
})
export const opencode300Text15 = defineFixture({
  width: 300,
  render: () => <Scene agent="opencode" fontSize={15} />
})

type StartFailureSetup = 'alone' | 'both' | 'resolved'

/** Start failures' transcript rows, each carrying the longer sentence an older host sent. */
function StartFailureRows({ setup }: { setup: StartFailureSetup }) {
  return (
    <div className="native-chat-appearance space-y-4 p-3">
      {AGENT_IDS.map((agent) => (
        <NativeChatHostSetupContext.Provider
          key={agent}
          value={setupsFor(agent, 'signedOut')[setup]}
        >
          <div className="space-y-2">
            <NativeChatNoticeRow
              agentName={AGENTS[agent].label}
              messageId={`failure-${agent}`}
              block={{
                type: 'text',
                tone: 'error',
                text: AGENTS[agent].oldSentence,
                failure: {
                  kind: 'notSignedIn',
                  ...(AGENTS[agent].account ? { account: AGENTS[agent].account } : {})
                }
              }}
            />
            {setup === 'both' ? (
              <Composer agent={agent} setup={setupsFor(agent, 'signedOut').alone} />
            ) : null}
          </div>
        </NativeChatHostSetupContext.Provider>
      ))}
    </div>
  )
}

/** A start failure's row alone: an older host's long sentence still reads short. */
export const transcriptRowOldHost = defineFixture({
  width: 520,
  render: () => <StartFailureRows setup="alone" />
})

/** A start failure's row while the composer's notice has Sign in: nothing was sent, so no "Not sent". */
export const transcriptRowStartFailureBoth = defineFixture({
  width: 520,
  render: () => <StartFailureRows setup="both" />
})

/** A failure a later successful turn resolved: history, so a plain muted line with no button. */
export const transcriptRowResolved = defineFixture({
  width: 520,
  render: () => <StartFailureRows setup="resolved" />
})
