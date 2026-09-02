import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  getEditingTargetFromSshConfigHost,
  getSshTargetDraftConnectionFields,
  hasAdvancedConnectionValues,
  isRelayGracePeriodValid,
  parseRelayGracePeriodSeconds,
  type EditingTarget
} from '../settings/ssh-target-draft'
import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_CONFIG_HOST_RESULT_LIMIT
} from '../../../../shared/ssh-types'
import type {
  SshConfigHostSummary,
  SshConfigHostListArgs,
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshRepoReadoption,
  SshTarget,
  SshTargetAddResult,
  SshTargetCreateInput
} from '../../../../shared/ssh-types'
import { isDuplicateSshTargetAlias } from './ssh-target-duplicate'

type SshApi = {
  listTargets: () => Promise<SshTarget[]>
  addTarget: (args: { target: SshTargetCreateInput }) => Promise<SshTargetAddResult>
  listConfigHosts: (args?: SshConfigHostListArgs) => Promise<SshConfigHostListResult>
  resolveConfigHost: (args: { alias: string }) => Promise<SshConfigHostResolution | null>
  importConfig: (args?: { reAdopt?: boolean }) => Promise<{
    targets: SshTarget[]
    repoReadoptions: SshRepoReadoption[]
  }>
}

export async function saveNewSshHostFromForm({
  form,
  ssh,
  recordSshRepoReadoptions,
  setSshTargetsMetadata,
  recordFeatureInteraction
}: {
  form: EditingTarget
  ssh: SshApi
  recordSshRepoReadoptions: (readoptions: readonly SshRepoReadoption[]) => void
  setSshTargetsMetadata: (targets: SshTarget[]) => void
  recordFeatureInteraction: (feature: 'ssh') => void
}): Promise<'saved' | 'validation-failed' | 'failed'> {
  const { host, configHost, username, port } = getSshTargetDraftConnectionFields(form)
  if (!host) {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshHostRequired',
        'Host or SSH config alias is required.'
      )
    )
    return 'validation-failed'
  }
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshPortInvalid',
        'Port must be between 1 and 65535.'
      )
    )
    return 'validation-failed'
  }
  const graceSeconds = parseRelayGracePeriodSeconds(form)
  if (!isRelayGracePeriodValid(form, graceSeconds)) {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshRelayGraceInvalid',
        'Terminal timeout must be between 60 and {{value0}} seconds.',
        { value0: MAX_SSH_RELAY_GRACE_PERIOD_SECONDS }
      )
    )
    return 'validation-failed'
  }

  const identityFile = form.identityFile.trim() || undefined
  const proxyCommand = form.proxyCommand.trim() || undefined
  const jumpHost = form.jumpHost.trim() || undefined
  const systemSshConnectionReuse = form.systemSshConnectionReuse ? undefined : false
  const target = {
    label: form.label.trim() || (username ? `${username}@${host}` : configHost || host),
    configHost,
    host,
    port,
    username,
    ...(form.gssapiAuthentication ? { gssapiAuthentication: true } : {}),
    relayGracePeriodSeconds: graceSeconds,
    ...(identityFile ? { identityFile } : {}),
    ...(proxyCommand ? { proxyCommand } : {}),
    ...(jumpHost ? { jumpHost } : {}),
    ...(systemSshConnectionReuse === false ? { systemSshConnectionReuse } : {})
  }

  try {
    const existingTargets = await ssh.listTargets()
    if (
      isDuplicateSshTargetAlias({
        existingTargets,
        configHost: target.configHost,
        label: target.label,
        host: target.host
      })
    ) {
      toast.error(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshAlreadyExists',
          'That SSH host is already in Orca.'
        )
      )
      return 'validation-failed'
    }

    const result = await ssh.addTarget({ target })
    recordSshRepoReadoptions(result.repoReadoptions)
    setSshTargetsMetadata(await ssh.listTargets())
    recordFeatureInteraction('ssh')
    toast.success(
      translate('auto.components.sidebar.AddRemoteHostDialog.sshSaved', 'SSH host added.')
    )
    return 'saved'
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshSaveFailed',
            'Failed to add SSH host.'
          )
    )
    return 'failed'
  }
}

export async function prefillFormFromSshConfigHost(
  host: SshConfigHostSummary,
  ssh: Pick<SshApi, 'resolveConfigHost'>
): Promise<{
  form: EditingTarget
  preferAdvancedOpen: boolean
} | null> {
  if (typeof ssh.resolveConfigHost !== 'function') {
    throw new Error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerRestartRequired',
        'Restart Orca to finish applying the SSH config picker update.'
      )
    )
  }
  const resolved = await ssh.resolveConfigHost({ alias: host.alias })
  if (!resolved) {
    return null
  }
  const form = getEditingTargetFromSshConfigHost(resolved)
  return {
    form,
    preferAdvancedOpen: hasAdvancedConnectionValues(form)
  }
}

/** Bulk-load ~/.ssh/config hosts into Orca’s host list (sidebar targets). */
export async function addAllSshConfigHostsToOrca({
  ssh,
  recordSshRepoReadoptions,
  setSshTargetsMetadata,
  recordFeatureInteraction
}: {
  ssh: SshApi
  recordSshRepoReadoptions: (readoptions: readonly SshRepoReadoption[]) => void
  setSshTargetsMetadata: (targets: SshTarget[]) => void
  recordFeatureInteraction: (feature: 'ssh') => void
}): Promise<{ kind: 'added'; count: number } | { kind: 'already-synced' } | { kind: 'failed' }> {
  try {
    // Why: no reAdopt — the button counts and promises only the *new* hosts the picker
    // showed. Re-adopting would resurrect hosts the user deleted, which the count omits.
    // Settings → Import stays the explicit re-adopt path.
    const result = await ssh.importConfig()
    recordSshRepoReadoptions(result.repoReadoptions)
    setSshTargetsMetadata(await ssh.listTargets())
    recordFeatureInteraction('ssh')
    if (result.targets.length === 0) {
      toast(
        translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshImportAlreadySynced',
          '~/.ssh/config already in sync.'
        )
      )
      return { kind: 'already-synced' }
    }
    toast.success(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.sshImportSynced',
        'Added {{value0}} host{{value1}} to Orca.',
        { value0: result.targets.length, value1: result.targets.length > 1 ? 's' : '' }
      )
    )
    return { kind: 'added', count: result.targets.length }
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshImportFailed',
            'Failed to import SSH config.'
          )
    )
    return { kind: 'failed' }
  }
}

export async function loadSshConfigHostsForPicker(
  ssh: SshApi,
  args?: SshConfigHostListArgs
): Promise<{ ok: true; result: SshConfigHostListResult } | { ok: false; error: string }> {
  try {
    const listed: unknown = await ssh.listConfigHosts(args)
    const result = normalizeSshConfigHostListResult(listed)
    if (!result) {
      throw new Error('Invalid SSH config host response')
    }
    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerLoadFailed',
              'Failed to read ~/.ssh/config.'
            )
    }
  }
}

function normalizeSshConfigHostListResult(value: unknown): SshConfigHostListResult | null {
  // Why: a renderer hot reload can briefly outlive the preload that returned the legacy array.
  if (Array.isArray(value)) {
    const hosts = value.slice(0, SSH_CONFIG_HOST_RESULT_LIMIT) as SshConfigHostSummary[]
    return {
      hosts,
      totalHostCount: value.length,
      newHostCount: value.filter(
        (host): host is SshConfigHostSummary =>
          typeof host === 'object' && host !== null && host.alreadyInOrca === false
      ).length,
      matchCount: value.length,
      hasMore: value.length > hosts.length
    }
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const result = value as Partial<SshConfigHostListResult>
  return Array.isArray(result.hosts) &&
    typeof result.totalHostCount === 'number' &&
    typeof result.newHostCount === 'number' &&
    typeof result.matchCount === 'number' &&
    typeof result.hasMore === 'boolean'
    ? (result as SshConfigHostListResult)
    : null
}
