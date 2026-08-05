import { MAX_SSH_RELAY_GRACE_PERIOD_SECONDS, type SshTarget } from '../../../../shared/ssh-types'
import {
  getSshTargetDraftConnectionFields,
  isRelayGracePeriodValid,
  parseRelayGracePeriodSeconds,
  type EditingTarget
} from './ssh-target-draft'
import { translate } from '../../i18n/i18n'

type SshTargetSavePayload = {
  target: Omit<SshTarget, 'id'>
  updates: Partial<Omit<SshTarget, 'id'>>
}

type SshTargetSavePayloadResult =
  | { ok: true; payload: SshTargetSavePayload }
  | { ok: false; error: string }

export function buildSshTargetSavePayload(form: EditingTarget): SshTargetSavePayloadResult {
  const { host, configHost, username, port } = getSshTargetDraftConnectionFields(form)
  if (!host) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshPane.0e5aa04161',
        'Host or SSH config alias is required'
      )
    }
  }

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshPane.4db9afce1c',
        'Port must be between 1 and 65535'
      )
    }
  }

  const parsedGraceSeconds = parseRelayGracePeriodSeconds(form)
  if (!isRelayGracePeriodValid(form, parsedGraceSeconds)) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshPane.3879cbaa52',
        'Terminal timeout must be between 60 and {{value0}} seconds, or keep terminals alive until reset.',
        { value0: MAX_SSH_RELAY_GRACE_PERIOD_SECONDS }
      )
    }
  }

  // Why: zmx hides the grace controls, so a stale unparsable draft falls back
  // to keep-alive instead of persisting NaN.
  const graceSeconds = Number.isNaN(parsedGraceSeconds) ? 0 : parsedGraceSeconds
  const identityFile = form.identityFile.trim() || undefined
  const proxyCommand = form.proxyCommand.trim() || undefined
  const jumpHost = form.jumpHost.trim() || undefined
  const systemSshConnectionReuse = form.systemSshConnectionReuse ? undefined : false
  // Why: persist only the non-default opt-in; updates clears via explicit undefined.
  const terminalPersistenceBackend = form.zmxTerminalPersistence ? ('zmx' as const) : undefined

  const target: Omit<SshTarget, 'id'> = {
    label: form.label.trim() || (username ? `${username}@${host}` : configHost),
    configHost,
    host,
    port,
    username,
    ...(form.gssapiAuthentication ? { gssapiAuthentication: true } : {}),
    relayGracePeriodSeconds: graceSeconds,
    ...(identityFile ? { identityFile } : {}),
    ...(proxyCommand ? { proxyCommand } : {}),
    ...(jumpHost ? { jumpHost } : {}),
    ...(systemSshConnectionReuse === false ? { systemSshConnectionReuse } : {}),
    ...(terminalPersistenceBackend ? { terminalPersistenceBackend } : {})
  }

  return {
    ok: true,
    payload: {
      target,
      updates: {
        ...target,
        // Why: updateTarget merges partially, so explicit undefined values are
        // required to clear optional fields inherited from ~/.ssh/config.
        identityFile,
        gssapiAuthentication: form.gssapiAuthentication || undefined,
        proxyCommand,
        jumpHost,
        systemSshConnectionReuse,
        terminalPersistenceBackend,
        source: 'manual'
      }
    }
  }
}
