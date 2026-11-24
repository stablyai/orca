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
  useAntigravityChatSignInStrip,
  type NativeChatSignInStripState
} from './NativeChatSignInStrip'
import { useStructuredAgentSessionHostProgram } from '../session/status/structured-agent-session-status-hooks'
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
  // Chats on the host program follow it too: Orca's agy may be what they need installed.
  const observation = useManagedRuntimeInstall(props.target, props.agent, props.isVisible)
  const slot = nativeChatInstallSlotState(observation, layout, hostProgram)
  const antigravity = props.agent === 'antigravity' && props.isVisible
  // Advisory, as the host's other verdicts: a login agy gets elsewhere isn't seen at once.
  const signIn = useAntigravityChatSignInStrip(
    antigravity && slot.kind === 'none' ? props.target : null,
    props.agent
  )
  const unavailableHint =
    slot.kind === 'install'
      ? managedRuntimeInstallCard(slot.state, agentLabel, slot.layout, undefined, t).title
      : undefined
  return {
    slot,
    signIn,
    sendBlockedReason: unavailableHint ?? installSlotSendBlockedReason(slot, agentLabel, t),
    unavailableHint,
    antigravityAuth: antigravity ? { host: props.target, ...antigravityAgy(observation) } : null
  }
}

/** Which agy runs Antigravity chats on the host, once its install status says. */
function antigravityAgy(
  observation: ManagedRuntimeInstallObservation
): Omit<NativeChatAntigravityAuthTarget, 'host'> {
  const state =
    observation.kind === 'active' && observation.snapshot.kind === 'known'
      ? observation.snapshot.state
      : null
  if (state?.program !== 'cli' || state.source === null) {
    return { agy: null, managedVersion: null }
  }
  return state.source === 'managed'
    ? { agy: 'orcas', managedVersion: state.installedVersion }
    : { agy: 'yours', managedVersion: null }
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
