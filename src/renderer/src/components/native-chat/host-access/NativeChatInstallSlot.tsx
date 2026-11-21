import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  managedRuntimeInstallCard,
  type ManagedRuntimeInstallLayout
} from '@/components/managed-runtime/managed-runtime-install-card'
import {
  useManagedRuntimeInstall,
  type ManagedRuntimeInstallObservation
} from '@/runtime/hosts/installation/use-managed-runtime-install'
import type { ManagedRuntimeInstallState } from '../../../../../shared/agent-launch/installation/managed-runtime-install'
import { NativeChatInstallStrip } from './NativeChatInstallStrip'
import {
  NativeChatSignInStrip,
  nativeChatSignInTitle,
  type NativeChatSignInStripState
} from './NativeChatSignInStrip'
import { useAntigravityChatSignIn } from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import {
  antigravityChatSignInPrompt,
  antigravityOrcaRuntimeSignsIn
} from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import {
  useStructuredAgentSessionAgentCopy,
  useStructuredAgentSessionHostProgram
} from '../session/status/structured-agent-session-status-hooks'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { findAgentCopy } from '../../../../../shared/agent-launch/catalog/agent-copies'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatStructuredViewProps } from '../native-chat-view-types'
import type { NativeChatAntigravityAuthTarget } from '../antigravity-auth/native-chat-antigravity-auth'

export type NativeChatInstallSlotState =
  | { kind: 'none' }
  /** The first status read is out: the composer stays, its sends held until the host answers. */
  | { kind: 'reserved' }
  | {
      kind: 'install'
      observation: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
      state: ManagedRuntimeInstallState
      layout: ManagedRuntimeInstallLayout
    }

export type NativeChatInstallSlotInstall = Extract<NativeChatInstallSlotState, { kind: 'install' }>

const NONE: NativeChatInstallSlotState = { kind: 'none' }
const RESERVED: NativeChatInstallSlotState = { kind: 'reserved' }

/** Reserve unknown readiness with an editable composer and held sends; missing runtimes show installation, while read failures leave it alone. */
export function useNativeChatInstallSlot(
  props: Pick<NativeChatStructuredViewProps, 'target' | 'agent' | 'isVisible' | 'sessionId'>,
  agentLabel: string,
  layout: ManagedRuntimeInstallLayout
): {
  slot: NativeChatInstallSlotState
  signIn: NativeChatSignInStripState | null
  sendBlockedReason: string | null
  unavailableHint: string | undefined
  /** How this Antigravity chat signs in on its host; null for every other chat. */
  antigravityAuth: NativeChatAntigravityAuthTarget | null
} {
  const t = useTranslate()
  const hostProgram = useStructuredAgentSessionHostProgram(props.sessionId, props.target)
  // Chats on the host program follow it too: Orca's copy of agy may be what they need installed.
  const observation = useManagedRuntimeInstall(props.target, props.agent, props.isVisible)
  const ownCommand = useAgentCopyOwnCommand(
    props.agent,
    useStructuredAgentSessionAgentCopy(props.sessionId, props.target),
    props.target
  )
  const slot = ownCommand ? NONE : nativeChatInstallSlotState(observation, layout, hostProgram)
  // Once Orca's own runtime is ready, chats still need its sign-in; the host's agy signs itself in.
  const signsIn = chatTakesOrcaRuntimeSignIn({
    agent: props.agent,
    visible: props.isVisible,
    hostProgram,
    ownCommand,
    slot,
    observation
  })
  const signInView = useAntigravityChatSignIn(signsIn ? props.target : null)
  const prompt = signsIn ? antigravityChatSignInPrompt(signInView) : null
  const signIn =
    prompt === null ? null : { prompt, view: signInView, agent: props.agent, host: props.target }
  const unavailableHint =
    slot.kind === 'install'
      ? managedRuntimeInstallCard(slot.state, agentLabel, slot.layout, undefined, t).title
      : signIn
        ? nativeChatSignInTitle(agentLabel, t)
        : undefined
  return {
    slot,
    signIn,
    sendBlockedReason: unavailableHint ?? installSlotSendBlockedReason(slot, agentLabel, t),
    unavailableHint,
    antigravityAuth:
      signsIn && observation.kind === 'active'
        ? {
            host: props.target,
            backend: 'managed',
            managedVersion:
              observation.snapshot.kind === 'known'
                ? observation.snapshot.state.installedVersion
                : null
          }
        : props.agent === 'antigravity' && props.isVisible && hostProgram
          ? {
              host: props.target,
              backend: 'agy',
              ...orcasAgy(observation),
              // Until the host says which agy is there, or while none is, the chip names none.
              programPending:
                slot.kind === 'install' ||
                observation.kind === 'pending' ||
                (observation.kind === 'active' && observation.snapshot.kind === 'unknown')
            }
          : null
  }
}

/** Only a chat on Orca's own Antigravity runtime, once installed, takes Orca's sign-in: never the
 *  host's agy, and never a copy with its own Command, which runs neither. */
export function chatTakesOrcaRuntimeSignIn(args: {
  agent: string
  visible: boolean
  hostProgram: boolean
  ownCommand: boolean
  slot: NativeChatInstallSlotState
  observation: ManagedRuntimeInstallObservation
}): boolean {
  const { observation } = args
  return (
    args.agent === 'antigravity' &&
    args.visible &&
    !args.hostProgram &&
    !args.ownCommand &&
    args.slot.kind === 'none' &&
    observation.kind === 'active' &&
    antigravityOrcaRuntimeSignsIn(observation)
  )
}

/** Whether this computer's chat runs as an agent copy with a Command of its own, which the host
 *  starts as it does an agent's own Command, so Orca's runtime is not needed. */
export function useAgentCopyOwnCommand(
  agent: string,
  copyId: string | null,
  target: RuntimeClientTarget
): boolean {
  return useAppStateValue((state) => {
    const copy =
      copyId && target.kind === 'local' ? findAgentCopy(state.settings, copyId) : undefined
    return Boolean(copy?.command && copy.agent === agent)
  })
}

/** Orca's installed agy is the one a chat on the host program runs; the person's own wins. */
function orcasAgy(observation: ManagedRuntimeInstallObservation) {
  const state =
    observation.kind === 'active' && observation.snapshot.kind === 'known'
      ? observation.snapshot.state
      : null
  return state?.program === 'cli' && state.source === 'managed'
    ? { orcasAgy: true, managedVersion: state.installedVersion }
    : {}
}

/** A chat on the host's own program needs an install only when that program is Orca's missing
 *  copy; an unanswered status never holds its sends. */
export function nativeChatInstallSlotState(
  observation: ManagedRuntimeInstallObservation,
  layout: ManagedRuntimeInstallLayout,
  hostProgram: boolean
): NativeChatInstallSlotState {
  if (hostProgram) {
    return observation.kind === 'active' &&
      observation.snapshot.kind === 'known' &&
      observation.snapshot.state.program === 'cli' &&
      observation.snapshot.state.source === null
      ? { kind: 'install', observation, state: observation.snapshot.state, layout }
      : NONE
  }
  if (observation.kind === 'inactive') {
    return NONE
  }
  if (observation.kind === 'pending') {
    return RESERVED
  }
  const { snapshot } = observation
  if (snapshot.kind === 'readFailed') {
    return NONE
  }
  if (snapshot.kind === 'unknown') {
    return RESERVED
  }
  return snapshot.state.source === null
    ? { kind: 'install', observation, state: snapshot.state, layout }
    : NONE
}

/** Send stays held until the host says it can run this agent. */
function installSlotSendBlockedReason(
  slot: NativeChatInstallSlotState,
  agentLabel: string,
  t: Translate = translate
): string | null {
  return slot.kind === 'none'
    ? null
    : t(
        'components.native-chat.install.checking',
        'Checking whether {{agent}} is ready on this host…',
        { agent: agentLabel }
      )
}

/** Setup stays reachable whenever the empty pane is not showing the hero. */
export function NativeChatInstallSlot(props: {
  install: { slot: NativeChatInstallSlotState; signIn: NativeChatSignInStripState | null }
  agentLabel: string
  /** A new bot's setup card offers the install and the sign-in itself. */
  inCard?: boolean
}): React.JSX.Element | null {
  const { slot, signIn } = props.install
  const strip = props.inCard ? null : slot.kind === 'install' && slot.layout === 'strip' ? (
    <NativeChatInstallStrip slot={slot} agentLabel={props.agentLabel} />
  ) : signIn ? (
    <NativeChatSignInStrip state={signIn} agentLabel={props.agentLabel} />
  ) : null
  if (!strip) {
    return null
  }
  return (
    <div className="min-h-0 shrink overflow-hidden bg-chat-pane">
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-1 sm:px-4">
        {strip}
      </div>
    </div>
  )
}
