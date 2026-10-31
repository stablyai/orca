import { translate } from '@/i18n/i18n'
import type { SshHostServerStatusLine } from './ssh-host-server-status-copy'

// Why a cap: a refusal can list every blocking tab; the whole text stays behind "Details".
export const REFUSAL_INLINE_CHARS = 280

// Main's refusal reason (orcad-migration-refusal-reason.ts) lists the blocking items after this lead.
const REFUSAL_LEAD = /^This SSH host cannot move yet:\s*/

/** A refusal Move anyway clears: say what stays on this computer, so moving is the obvious next step. */
export function leaveBehindLine(
  detail: string | undefined,
  inlineChars: number
): SshHostServerStatusLine {
  const reason = detail?.trim() ?? ''
  const items = reason.replace(REFUSAL_LEAD, '').replace(/\.$/, '')
  const inline = items.length > inlineChars ? `${items.slice(0, inlineChars).trimEnd()}…` : items
  return {
    tone: 'warning',
    text: inline
      ? translate(
          'auto.components.settings.sshHostServer.refusedLeaveBehind',
          'Some saved items for this host can’t move to its Orca server: {{items}}. Move anyway connects the host and keeps them on this computer.',
          { items: inline }
        )
      : translate(
          'auto.components.settings.sshHostServer.refusedLeaveBehindUnnamed',
          'Some saved items for this host can’t move to its Orca server. Move anyway connects the host and keeps them on this computer.'
        ),
    ...(reason ? { detail: reason } : {})
  }
}

/** Names what refuses the move; main writes that reason, with the way out, in English. */
export function refusedLine(
  detail: string | undefined,
  inlineChars: number
): SshHostServerStatusLine {
  const reason = detail?.trim()
  if (!reason) {
    return {
      tone: 'destructive',
      text: translate(
        'auto.components.settings.sshHostServer.refusedBlocked',
        'Orca isn’t set up on this host yet: something on the host stops the move.'
      )
    }
  }
  const inline = reason.length > inlineChars ? `${reason.slice(0, inlineChars).trimEnd()}…` : reason
  return {
    tone: 'destructive',
    text: translate(
      'auto.components.settings.sshHostServer.refusedBlockedReason',
      'Orca isn’t set up on this host yet. {{reason}}',
      { reason: inline }
    ),
    detail: reason
  }
}
