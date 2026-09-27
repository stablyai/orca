import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshServiceLink,
  type SshTargetCreateInput,
  type SshTargetUpdateInput
} from '../../../../shared/ssh-types'
import {
  MAX_SSH_SERVICE_LINKS,
  MAX_SSH_SERVICE_LINK_LABEL_LENGTH,
  normalizeSshServiceLink
} from '../../../../shared/ssh-service-links'
import {
  getSshTargetDraftConnectionFields,
  isRelayGracePeriodValid,
  parseRelayGracePeriodSeconds,
  type EditingTarget,
  type SshServiceLinkDraft
} from './ssh-target-draft'
import { translate } from '../../i18n/i18n'

type SshTargetSavePayload = {
  target: SshTargetCreateInput
  updates: SshTargetUpdateInput
}

type SshTargetSavePayloadResult =
  | { ok: true; payload: SshTargetSavePayload }
  | { ok: false; error: string }

function serviceLinksForSave(drafts: SshServiceLinkDraft[]): SshServiceLink[] | null {
  if (drafts.length > MAX_SSH_SERVICE_LINKS) {
    return null
  }
  const links: SshServiceLink[] = []
  // Why: a half-typed row is a form error, not a silently dropped link — the row stays visible for the user to fix.
  for (const draft of drafts) {
    const link = normalizeSshServiceLink(draft)
    if (!link) {
      return null
    }
    links.push(link)
  }
  return links
}

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
  const systemSshConnectionReuse = form.systemSshConnectionReuse ? undefined : false

  const serviceLinks = serviceLinksForSave(form.serviceLinks)
  if (!serviceLinks) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshTargetForm.serviceLinksInvalid',
        'Each service link needs a label of 1 to {{value0}} characters and an http:// or https:// URL, with at most {{value1}} links.',
        { value0: MAX_SSH_SERVICE_LINK_LABEL_LENGTH, value1: MAX_SSH_SERVICE_LINKS }
      )
    }
  }
  const serviceLinksValue = serviceLinks.length > 0 ? serviceLinks : undefined

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
    ...(systemSshConnectionReuse === false ? { systemSshConnectionReuse } : {}),
    ...(serviceLinksValue ? { serviceLinks: serviceLinksValue } : {})
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
        serviceLinks: serviceLinksValue,
        source: 'manual'
      }
    }
  }
}
