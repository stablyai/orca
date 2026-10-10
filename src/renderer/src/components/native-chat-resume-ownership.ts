import { translate } from '@/i18n/i18n'
import {
  parseRestartOfferOrigin,
  type RestartOfferOrigin
} from '../../../shared/restart-offer-origin'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/**
 * Whose interrupted chat this is, as its host judged it for this desktop (see `restartOfferOrigin`):
 * by workspace, with the sidebar's rule. Only `own` is ticked by default, announced by a reconnect
 * toast, or continued without asking; every other answer is still listed, unticked, with where it
 * came from. `unknown` is a host that sent no answer, which is never treated as the user's.
 */
export type ResumeWorkspaceOwnership = RestartOfferOrigin | 'unknown'

export function resumeCandidateOwnership(
  candidate: Pick<ResumeCandidate, 'origin'>
): ResumeWorkspaceOwnership {
  return parseRestartOfferOrigin(candidate.origin) ?? 'unknown'
}

/** The label beside a chat that does not start ticked; none for the user's own. */
export function resumeOwnershipLabel(
  ownership: ResumeWorkspaceOwnership,
  machineName: string
): string | undefined {
  switch (ownership) {
    case 'own':
      return undefined
    case 'automation':
      return translate(
        'auto.components.NativeChatResumeOnRestartModal.originAutomation',
        'Automation'
      )
    case 'other-device':
      return translate(
        'auto.components.NativeChatResumeOnRestartModal.originOtherDevice',
        'Another device'
      )
    case 'server-made':
      return translate(
        'auto.components.NativeChatResumeOnRestartModal.originServer',
        'Made on {{value0}}',
        { value0: machineName }
      )
    case 'unknown':
      return translate(
        'auto.components.NativeChatResumeOnRestartModal.originUnknown',
        'Unknown origin'
      )
  }
}
