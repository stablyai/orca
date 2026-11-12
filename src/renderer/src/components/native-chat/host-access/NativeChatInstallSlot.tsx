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
import type { ManagedRuntimeInstallState } from '../../../../../shared/managed-runtime-install'
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
import { useStructuredAgentSessionHostProgram } from '../session/status/structured-agent-session-status-hooks'
import type { NativeChatStructuredViewProps } from '../native-chat-view-types'

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
} {
  const t = useTranslate()
  const hostProgram = useStructuredAgentSessionHostProgram(props.sessionId, props.target)
  const observation = useManagedRuntimeInstall(
    props.target,
    props.agent,
    props.isVisible && !hostProgram
  )
  const slot = nativeChatInstallSlotState(observation, layout, hostProgram)
  // Once Orca's own runtime is ready, chats still need its sign-in; the host's agy signs itself in.
  const signsIn =
    props.agent === 'antigravity' &&
    props.isVisible &&
    slot.kind === 'none' &&
    observation.kind === 'active' &&
    antigravityOrcaRuntimeSignsIn(observation)
  const signInView = useAntigravityChatSignIn(signsIn ? props.target : null)
  const prompt = signsIn ? antigravityChatSignInPrompt(signInView) : null
  const signIn = prompt === null ? null : { prompt, view: signInView, agent: props.agent }
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
    unavailableHint
  }
}

/** A chat running the host's own program needs no managed install, whatever its state. */
export function nativeChatInstallSlotState(
  observation: ManagedRuntimeInstallObservation,
  layout: ManagedRuntimeInstallLayout,
  hostProgram: boolean
): NativeChatInstallSlotState {
  if (hostProgram || observation.kind === 'inactive') {
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
}): React.JSX.Element | null {
  const { slot, signIn } = props.install
  const strip =
    slot.kind === 'install' && slot.layout === 'strip' ? (
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
