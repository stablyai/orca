import type { OwnerNotSetUpPlaceholder } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

function translateOwnerNotSetUpLabel(
  placeholder: OwnerNotSetUpPlaceholder,
  server: string,
  t: Translate = translate
): string {
  return placeholder.kind === 'claude-unknown'
    ? t('auto.components.status.bar.tooltip.claudeNoUsageFromHost', 'No usage from {{server}}', {
        server
      })
    : t(
        'auto.components.status.bar.tooltip.remoteOwnerNotConfigured',
        'Not configured on {{server}}',
        { server }
      )
}

export function getOwnerNotSetUpLabel(
  placeholder: OwnerNotSetUpPlaceholder,
  t?: Translate
): string {
  return translateOwnerNotSetUpLabel(placeholder, placeholder.ownerLabel, t)
}

export function getOwnerNotSetUpNote(
  placeholder: OwnerNotSetUpPlaceholder,
  t: Translate = translate
): string | null {
  if (placeholder.kind === 'claude-unknown') {
    return t(
      'auto.components.status.bar.tooltip.claudeUnknownOnHost',
      "Claude usage isn't available from {{server}}. It may not be signed in there, or it may use API-key billing.",
      { server: placeholder.ownerLabel }
    )
  }
  return placeholder.signInSavedHereOnly
    ? t(
        'auto.components.status.bar.tooltip.remoteOwnerSignInSavedHere',
        'Its sign-in is saved on this computer only.'
      )
    : null
}

export function describeOwnerNotSetUp(
  placeholder: OwnerNotSetUpPlaceholder,
  t?: Translate
): string {
  const note = getOwnerNotSetUpNote(placeholder, t)
  // Why: Claude's note already names the host, so it stands alone.
  if (placeholder.kind === 'claude-unknown' && note) {
    return note
  }
  const label = getOwnerNotSetUpLabel(placeholder, t)
  return note ? `${label}\n${note}` : label
}
