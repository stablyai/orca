import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshTarget,
  type SshTargetCreateInput,
  type SshTargetUpdateInput
} from '../../../../shared/ssh-types'
import { normalizeProxyBypassRules, normalizeProxyUrl } from '../../../../shared/network-proxy'
import {
  getSshTargetDraftConnectionFields,
  isRelayGracePeriodValid,
  parseRelayGracePeriodSeconds,
  type EditingTarget
} from './ssh-target-draft'
import { translate } from '../../i18n/i18n'

type SshTargetSavePayload = {
  target: SshTargetCreateInput
  updates: SshTargetUpdateInput
}

type SshTargetSavePayloadResult =
  | { ok: true; payload: SshTargetSavePayload }
  | { ok: false; error: string }

/** The saved values a proxy edit is compared against, so an unchanged field is left out. */
type SshTargetProxyBaseline = Pick<SshTarget, 'httpProxyUrl' | 'httpProxyBypassRules'>

export function buildSshTargetSavePayload(
  form: EditingTarget,
  baseline?: SshTargetProxyBaseline
): SshTargetSavePayloadResult {
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

  const graceSeconds = parseRelayGracePeriodSeconds(form)
  if (!isRelayGracePeriodValid(form, graceSeconds)) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshPane.3879cbaa52',
        'Terminal timeout must be between 60 and {{value0}} seconds, or keep terminals alive until reset.',
        { value0: MAX_SSH_RELAY_GRACE_PERIOD_SECONDS }
      )
    }
  }

  const identityFile = form.identityFile.trim() || undefined
  const proxyCommand = form.proxyCommand.trim() || undefined
  const jumpHost = form.jumpHost.trim() || undefined
  // Why: validate here so a malformed URL never persists as a per-host proxy that
  // would then be injected verbatim into every terminal on that host.
  const httpProxy = normalizeProxyUrl(form.httpProxyUrl)
  if (form.httpProxyUrl.trim() && !httpProxy.ok) {
    return { ok: false, error: httpProxy.message }
  }
  const httpProxyUrl = httpProxy.value || undefined
  const httpProxyBypassRules = normalizeProxyBypassRules(form.httpProxyBypassRules) || undefined
  // Why omit unchanged proxy fields, per field: this form submits a full snapshot, and
  // persistence reads a present-but-empty httpProxyUrl as the user clearing the proxy
  // (releasing any sealed ciphertext). The stored baseline is '' both for a target that
  // never had a proxy and for one whose proxy is keychain-sealed, so it must be pushed
  // through the same normalizers before comparing — `?? undefined` would never equate
  // that '' with the form's undefined and every save would look like a clear. Comparing
  // each field on its own also keeps a bypass-only edit from shipping an empty URL.
  const baselineProxyUrl = normalizeProxyUrl(baseline?.httpProxyUrl ?? '').value || undefined
  const baselineBypassRules = normalizeProxyBypassRules(baseline?.httpProxyBypassRules) || undefined
  const proxyUpdates = {
    ...(baselineProxyUrl !== httpProxyUrl ? { httpProxyUrl } : {}),
    ...(baselineBypassRules !== httpProxyBypassRules ? { httpProxyBypassRules } : {})
  }
  const systemSshConnectionReuse = form.systemSshConnectionReuse ? undefined : false
  const remoteRuntime = form.remoteRuntime === 'auto' ? undefined : form.remoteRuntime

  const target: SshTargetCreateInput = {
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
    ...(httpProxyUrl ? { httpProxyUrl } : {}),
    ...(httpProxyBypassRules ? { httpProxyBypassRules } : {}),
    ...(systemSshConnectionReuse === false ? { systemSshConnectionReuse } : {}),
    ...(remoteRuntime ? { remoteRuntime } : {}),
    ...(form.allowRemoteCliControl ? { allowRemoteCliControl: true } : {})
  }

  // Why destructure: the spread below would otherwise re-send an unchanged proxy on
  // every save; proxy fields reach `updates` only through proxyUpdates.
  const {
    httpProxyUrl: _createProxyUrl,
    httpProxyBypassRules: _createProxyBypass,
    ...targetWithoutProxy
  } = target

  return {
    ok: true,
    payload: {
      target,
      updates: {
        ...targetWithoutProxy,
        // Why: updateTarget merges partially, so explicit undefined values are
        // required to clear optional fields inherited from ~/.ssh/config.
        identityFile,
        gssapiAuthentication: form.gssapiAuthentication || undefined,
        proxyCommand,
        jumpHost,
        ...proxyUpdates,
        systemSshConnectionReuse,
        remoteRuntime,
        allowRemoteCliControl: form.allowRemoteCliControl || undefined,
        source: 'manual'
      }
    }
  }
}
