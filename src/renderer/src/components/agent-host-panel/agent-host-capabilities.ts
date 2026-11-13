// A16 (agent-accounts spec v4 §4): what the per-host panel shows, hides and disables for each host
// kind. The layout never changes by kind; kinds only hide rows, disable actions with a stated reason,
// or add Cloud rows. Every string here is the spec's exact copy.
import type { Translate } from '@/i18n/use-translate'

export type AgentHostKind =
  | 'local'
  | 'sshClassic'
  | 'sshOrcad'
  | 'wsl'
  | 'recipe'
  | 'paired'
  | 'cloud'

/** Why the host can or can't answer now. The panel never changes it (no wake, start, resume, connect). */
export type AgentHostAvailability =
  | 'available'
  | 'disconnected'
  | 'stopped'
  | 'suspended'
  | 'unreachable'
  | 'asleep'
  | 'archived'

export type AgentHostFooterLink =
  | 'accounts'
  | 'agentAccounts'
  | 'agentApiKeys'
  | 'cloudSecrets'
  | 'customEnvironments'
  | 'allHosts'

export type AgentHostCapabilities = {
  kindLabel: string
  stateLabel: string | null
  agents: { title: string; help: string }
  keys: { title: string; help: string }
  /** Section 3's one honest line; null where a richer section renders instead (Cloud, recipe). */
  environmentHelp: string | null
  /** A neutral notice above section 1 while the host can't answer. */
  notice: string | null
  /** Sign-in and sign-out need the host: the reason they're disabled, or null. */
  actionsDisabledReason: string | null
  /** Cloud only: the two-way Source per agent. */
  source: boolean
  /** Cloud only: sections 2–3 come from Cloud secrets. */
  cloudSecrets: boolean
  /** Sign out… lives here (moved from the host ⋯ menu); never on Cloud or this computer. */
  signOut: boolean
  footer: readonly AgentHostFooterLink[]
}

export function agentHostKindLabel(kind: AgentHostKind, t: Translate): string {
  switch (kind) {
    case 'local':
      return t('agentHostPanel.kind.local', 'This computer')
    case 'sshClassic':
    case 'sshOrcad':
      return t('agentHostPanel.kind.ssh', 'SSH host')
    case 'wsl':
      return t('agentHostPanel.kind.wsl', 'WSL')
    case 'recipe':
      return t('agentHostPanel.kind.recipe', 'Custom environment')
    case 'paired':
      return t('agentHostPanel.kind.paired', 'Paired')
    case 'cloud':
      return t('agentHostPanel.kind.cloud', 'Orca Cloud')
  }
}

function stateLabel(
  kind: AgentHostKind,
  availability: AgentHostAvailability,
  t: Translate
): string | null {
  switch (availability) {
    case 'available':
      return kind === 'local'
        ? null
        : kind === 'cloud' || kind === 'recipe'
          ? t('agentHostPanel.state.running', 'Running')
          : t('agentHostPanel.state.connected', 'Connected')
    case 'disconnected':
      return t('agentHostPanel.state.disconnected', 'Not connected')
    case 'stopped':
      return t('agentHostPanel.state.stopped', 'Stopped')
    case 'suspended':
      return t('agentHostPanel.state.suspended', 'Suspended')
    case 'unreachable':
      return t('agentHostPanel.state.unreachable', 'Unreachable')
    case 'asleep':
      return t('agentHostPanel.state.asleep', 'Asleep')
    case 'archived':
      return t('agentHostPanel.state.archived', 'Archived')
  }
}

type NoticeContext = { host: string; date: string | null }

/** Spec §4 "Disabled, with reason" and the neutral notices, by kind and availability. */
function unavailableCopy(
  kind: AgentHostKind,
  availability: AgentHostAvailability,
  { host, date }: NoticeContext,
  t: Translate
): { notice: string; reason: string } | null {
  if (availability === 'available' || kind === 'local' || kind === 'cloud') {
    return null
  }
  if (kind === 'wsl' && availability === 'stopped') {
    return {
      notice: date
        ? t(
            'agentHostPanel.notice.wslStopped',
            '{{distro}} is stopped. Showing its last check, {{date}}. Opening a workspace on it starts it as usual.',
            { distro: host, date }
          )
        : t(
            'agentHostPanel.notice.wslStoppedNoDate',
            '{{distro}} is stopped. Opening a workspace on it starts it as usual.',
            { distro: host }
          ),
      reason: t(
        'agentHostPanel.reason.wslStopped',
        '{{distro}} is stopped. Opening a workspace on it starts it as usual.',
        { distro: host }
      )
    }
  }
  if (kind === 'recipe' && availability === 'suspended') {
    return {
      notice: date
        ? t(
            'agentHostPanel.notice.recipeSuspended',
            '{{host}} is suspended. Showing its last check, {{date}}. Opening the workspace resumes it as usual.',
            { host, date }
          )
        : t(
            'agentHostPanel.notice.recipeSuspendedNoDate',
            '{{host}} is suspended. Opening the workspace resumes it as usual.',
            { host }
          ),
      reason: t(
        'agentHostPanel.reason.recipeSuspended',
        '{{host}} is suspended. Opening the workspace resumes it as usual.',
        { host }
      )
    }
  }
  if ((kind === 'sshClassic' || kind === 'sshOrcad') && availability === 'disconnected') {
    return {
      notice: date
        ? t(
            'agentHostPanel.notice.sshDisconnected',
            '{{host}} isn’t connected. Showing its last check, {{date}}.',
            { host, date }
          )
        : t('agentHostPanel.notice.sshDisconnectedNoDate', '{{host}} isn’t connected.', { host }),
      reason: t(
        'agentHostPanel.reason.sshDisconnected',
        'Open a workspace on {{host}} to sign in or out.',
        { host }
      )
    }
  }
  return {
    notice: date
      ? t(
          'agentHostPanel.notice.unreachable',
          'Can’t reach {{host}}. Showing what it reported on {{date}}. Sign-in and sign-out need it online.',
          { host, date }
        )
      : t(
          'agentHostPanel.notice.unreachableNoDate',
          'Can’t reach {{host}}. Sign-in and sign-out need it online.',
          { host }
        ),
    reason: t(
      'agentHostPanel.reason.unreachable',
      'Can’t reach {{host}}. Sign-in and sign-out need it online.',
      { host }
    )
  }
}

function sectionHelp(
  kind: AgentHostKind,
  host: string,
  t: Translate
): { agents: string; keys: string; environment: string | null } {
  const onHost = t(
    'agentHostPanel.help.agentsHost',
    'The agent’s own sign-in, saved on {{host}}. Never copied from this computer.',
    { host }
  )
  const passed = t(
    'agentHostPanel.help.keysPassed',
    'Passed to the agent when it starts. Not stored on {{host}}.',
    { host }
  )
  switch (kind) {
    case 'local':
      return {
        agents: t(
          'agentHostPanel.help.agentsLocal',
          'The agent’s own sign-in on this computer. Switch between saved accounts in Accounts.'
        ),
        keys: t(
          'agentHostPanel.help.keysLocal',
          'From Agent API keys. Sealed in your keychain and passed to the agent when it starts.'
        ),
        environment: t(
          'agentHostPanel.help.envLocal',
          'Agents here get this computer’s environment. Orca doesn’t add variables.'
        )
      }
    case 'sshClassic':
    case 'sshOrcad':
      return {
        agents: onHost,
        keys:
          kind === 'sshClassic'
            ? t(
                'agentHostPanel.help.keysSsh',
                'Sent over SSH when the agent starts. Not stored on {{host}}.',
                { host }
              )
            : passed,
        environment: t(
          'agentHostPanel.help.envSsh',
          'Agents on {{host}} use its shell profile. Orca doesn’t add variables on SSH hosts.',
          { host }
        )
      }
    case 'wsl':
      return {
        agents: t(
          'agentHostPanel.help.agentsWsl',
          'Sign-ins inside the distro. Windows sign-ins don’t carry over.'
        ),
        keys: passed,
        environment: t(
          'agentHostPanel.help.envWsl',
          'Agents get the distro’s own environment. Orca doesn’t add variables in WSL.'
        )
      }
    case 'recipe':
      // Section 3 is the environment-forwarding warning instead of a line.
      return { agents: onHost, keys: passed, environment: null }
    case 'paired':
      return {
        agents: onHost,
        keys: passed,
        environment: t(
          'agentHostPanel.help.envPaired',
          'Agents on {{host}} use its own environment. Orca doesn’t add variables on paired hosts.',
          { host }
        )
      }
    case 'cloud':
      return {
        agents: t(
          'agentHostPanel.help.agentsCloudSignIns',
          'Agent sign-ins aren’t stored in the sandbox, so new, cloned and restarted sandboxes work the same.'
        ),
        // Sections 2–3 on Cloud carry their own help (Cloud secrets).
        keys: '',
        environment: null
      }
  }
}

function footerLinks(kind: AgentHostKind): readonly AgentHostFooterLink[] {
  switch (kind) {
    case 'local':
      return ['accounts', 'agentApiKeys', 'allHosts']
    case 'recipe':
      return ['agentApiKeys', 'customEnvironments', 'allHosts']
    case 'cloud':
      return ['agentAccounts', 'cloudSecrets', 'allHosts']
    case 'sshClassic':
    case 'sshOrcad':
    case 'wsl':
    case 'paired':
      return ['agentApiKeys', 'allHosts']
  }
}

/** The one table every kind renders from (spec §4 "What the panel hides or disables, by kind"). */
export function hostCapabilities(
  kind: AgentHostKind,
  availability: AgentHostAvailability,
  context: NoticeContext,
  t: Translate
): AgentHostCapabilities {
  const help = sectionHelp(kind, context.host, t)
  const unavailable = unavailableCopy(kind, availability, context, t)
  const cloud = kind === 'cloud'
  return {
    kindLabel: agentHostKindLabel(kind, t),
    stateLabel: stateLabel(kind, availability, t),
    agents: {
      title: cloud
        ? t('agentHostPanel.section.agentsCloud', 'Agents')
        : t('agentHostPanel.section.agents', 'Agent sign-ins'),
      help: help.agents
    },
    keys: {
      title: t('agentHostPanel.section.keys', 'API keys Orca sends to agents here'),
      help: help.keys
    },
    environmentHelp: help.environment,
    notice: unavailable?.notice ?? null,
    actionsDisabledReason: cloud
      ? availability === 'archived'
        ? t('agentHostPanel.reason.archived', 'This workspace is archived.')
        : null
      : (unavailable?.reason ?? null),
    source: cloud,
    cloudSecrets: cloud,
    signOut: !cloud && kind !== 'local',
    footer: footerLinks(kind)
  }
}
