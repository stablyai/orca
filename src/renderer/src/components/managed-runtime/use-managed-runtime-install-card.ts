import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  cancelManagedRuntimeInstall,
  installManagedRuntime
} from '@/runtime/managed-runtime-install-status'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
import type { ManagedRuntimeInstallState } from '../../../../shared/managed-runtime-install'
import {
  managedRuntimeInstallCard,
  type ManagedRuntimeInstallCard,
  type ManagedRuntimeInstallLayout
} from './managed-runtime-install-card'
import type { ManagedRuntimeInstallAction } from './managed-runtime-install-view'

/** The install card and its Install / Cancel clicks. A click holds its button (`pending`) until
 *  the host answers, so a double click starts nothing twice; `refusal` is why the host turned the
 *  last click down. */
export function useManagedRuntimeInstallCard(
  observation: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>,
  state: ManagedRuntimeInstallState,
  agentLabel: string,
  layout: ManagedRuntimeInstallLayout
): {
  card: ManagedRuntimeInstallCard
  pending: boolean
  refusal: string | null
  act: (action: ManagedRuntimeInstallAction) => void
} {
  const [pending, setPending] = useState<ManagedRuntimeInstallAction['kind'] | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const act = (action: ManagedRuntimeInstallAction): void => {
    setPending(action.kind)
    setRefusal(null)
    const { subject } = observation
    const call =
      action.kind === 'cancel'
        ? cancelManagedRuntimeInstall(subject, action.operationId)
        : installManagedRuntime(subject)
    void call
      .catch((cause: unknown) =>
        setRefusal(
          cause instanceof Error
            ? cause.message
            : action.kind === 'cancel'
              ? translate(
                  'components.managed-runtime.cancelFailed',
                  "Couldn't cancel the installation. Try again."
                )
              : translate('components.managed-runtime.failed', 'Installation failed. Try again.')
        )
      )
      .finally(() => setPending(null))
  }
  const card = managedRuntimeInstallCard(state, agentLabel, layout, pending === 'cancel')
  return {
    // An offer's hint points at Settings › Chat › Providers, which installs on this computer only.
    card:
      card.tone === 'offer' && observation.subject.target.kind !== 'local'
        ? { ...card, hint: null }
        : card,
    pending: pending !== null,
    refusal,
    act
  }
}
