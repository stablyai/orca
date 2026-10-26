import type { OwnerNotSetUpPlaceholder } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'

function translateOwnerNotSetUpLabel(
  placeholder: OwnerNotSetUpPlaceholder,
  server: string
): string {
  return placeholder.kind === 'claude-unknown'
    ? translate(
        'auto.components.status.bar.tooltip.claudeNoUsageFromHost',
        'No usage from {{server}}',
        {
          server
        }
      )
    : translate(
        'auto.components.status.bar.tooltip.remoteOwnerNotConfigured',
        'Not configured on {{server}}',
        { server }
      )
}

export function getOwnerNotSetUpLabel(placeholder: OwnerNotSetUpPlaceholder): string {
  return translateOwnerNotSetUpLabel(placeholder, placeholder.ownerLabel)
}

// Why a sentinel, not Trans markup: a host name containing "<" would parse as markup.
const HOST_SLOT = '\u0000'

/** The label split around the host name, so only the name truncates wherever the locale puts it. */
export function getOwnerNotSetUpLabelParts(placeholder: OwnerNotSetUpPlaceholder): {
  before: string
  host: string
  after: string
} {
  const template = translateOwnerNotSetUpLabel(placeholder, HOST_SLOT)
  const slot = template.indexOf(HOST_SLOT)
  if (slot === -1) {
    return { before: getOwnerNotSetUpLabel(placeholder), host: '', after: '' }
  }
  return {
    before: template.slice(0, slot),
    host: placeholder.ownerLabel,
    after: template.slice(slot + HOST_SLOT.length)
  }
}

export function getOwnerNotSetUpNote(placeholder: OwnerNotSetUpPlaceholder): string | null {
  if (placeholder.kind === 'claude-unknown') {
    return translate(
      'auto.components.status.bar.tooltip.claudeUnknownOnHost',
      "Claude usage isn't available from {{server}}. It may not be signed in there, or it may use API-key billing.",
      { server: placeholder.ownerLabel }
    )
  }
  return placeholder.signInSavedHereOnly
    ? translate(
        'auto.components.status.bar.tooltip.remoteOwnerSignInSavedHere',
        'Its sign-in is saved on this computer only.'
      )
    : null
}

export function describeOwnerNotSetUp(placeholder: OwnerNotSetUpPlaceholder): string {
  const note = getOwnerNotSetUpNote(placeholder)
  // Why: Claude's note already names the host, so it stands alone.
  if (placeholder.kind === 'claude-unknown' && note) {
    return note
  }
  const label = getOwnerNotSetUpLabel(placeholder)
  return note ? `${label}\n${note}` : label
}
