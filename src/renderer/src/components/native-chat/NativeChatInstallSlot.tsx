import { translate } from '@/i18n/i18n'
import {
  managedRuntimeInstallCard,
  type ManagedRuntimeInstallLayout
} from '@/components/managed-runtime/managed-runtime-install-card'
import {
  useManagedRuntimeInstall,
  type ManagedRuntimeInstallObservation
} from '@/runtime/use-managed-runtime-install'
import type { ManagedRuntimeInstallState } from '../../../../shared/managed-runtime-install'
import { NativeChatInstallStrip } from './NativeChatInstallStrip'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'

/** What a chat's input slot holds for the program its host must install first. */
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

/** Install shows while the chat's host has nothing to run, its install included, and the composer
 *  stays disabled beneath it; anything runnable, or a status the host could not report, leaves
 *  the composer alone. Until the host says whether it provides the program, the composer stays
 *  usable but sends nothing. */
export function useNativeChatInstallSlot(
  props: Pick<NativeChatStructuredViewProps, 'target' | 'agent' | 'isVisible'>,
  agentLabel: string,
  layout: ManagedRuntimeInstallLayout
): {
  slot: NativeChatInstallSlotState
  sendBlockedReason: string | null
  unavailableHint: string | undefined
} {
  const slot = installSlotState(
    useManagedRuntimeInstall(props.target, props.agent, props.isVisible),
    layout
  )
  const unavailableHint =
    slot.kind === 'install'
      ? managedRuntimeInstallCard(slot.state, agentLabel, slot.layout).title
      : undefined
  return {
    slot,
    sendBlockedReason: unavailableHint ?? installSlotSendBlockedReason(slot, agentLabel),
    unavailableHint
  }
}

function installSlotState(
  observation: ManagedRuntimeInstallObservation,
  layout: ManagedRuntimeInstallLayout
): NativeChatInstallSlotState {
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
  agentLabel: string
): string | null {
  return slot.kind === 'none'
    ? null
    : translate(
        'components.native-chat.install.checking',
        'Checking whether {{agent}} is ready on this host…',
        { agent: agentLabel }
      )
}

/** Setup stays reachable whenever the empty pane is not showing the hero. */
export function NativeChatInstallSlot(props: {
  slot: NativeChatInstallSlotState
  agentLabel: string
}): React.JSX.Element | null {
  const { slot } = props
  if (slot.kind !== 'install' || slot.layout !== 'strip') {
    return null
  }
  return (
    <div className="min-h-0 shrink overflow-hidden bg-chat-canvas">
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-1 sm:px-4">
        <NativeChatInstallStrip slot={slot} agentLabel={props.agentLabel} />
      </div>
    </div>
  )
}
