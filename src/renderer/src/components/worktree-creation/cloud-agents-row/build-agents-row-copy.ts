// Words for the cloud build sheet's Agents row (spec §5b, redesign §5). Catalog names only.
import type { Translate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import type {
  BuildAgentVia,
  BuildAgentsRowModel
} from '@/lib/orca-cloud/orca-cloud-build-agents-row'
import type { OrcaCloudAccountAgent } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  agentName,
  keyPhrase,
  productName,
  setupFailureCopy
} from '../../settings/agent-accounts/orca-cloud-accounts-copy'

/** "Claude and Codex" in the user's language (Intl.ListFormat, never concatenation). */
export function agentList(agents: readonly OrcaCloudAccountAgent[], t: Translate): string {
  const names = agents.map((agent) => agentName(agent, t))
  try {
    return new Intl.ListFormat(getIntlLocale(), { style: 'long', type: 'conjunction' }).format(
      names
    )
  } catch {
    return names.join(', ')
  }
}

/** One source group: "Claude and Codex from your Orca account" / "Codex with the team key". */
function groupLabel(via: BuildAgentVia, agents: string, t: Translate): string {
  return via === 'account'
    ? t('vmBuildAgents.groupAccount', '{{agents}} from your Orca account', { agents })
    : t('vmBuildAgents.groupKey', '{{agents}} with {{key}}', { agents, key: keyPhrase(via, t) })
}

/**
 * R1: "Claude and Codex from your Orca account · nw@stably.ai". Mixed sources: one group per
 * source, and the "·" separates groups only: "Claude from your Orca account · Codex with the team key".
 */
export function readyLine(
  model: Extract<BuildAgentsRowModel, { kind: 'ready' }>,
  t: Translate
): string {
  const groups = new Map<BuildAgentVia, OrcaCloudAccountAgent[]>()
  for (const entry of model.covered) {
    groups.set(entry.via, [...(groups.get(entry.via) ?? []), entry.agent])
  }
  const parts = [...groups].map(([via, agents]) => groupLabel(via, agentList(agents, t), t))
  if (model.label) {
    parts.push(model.label)
  }
  return parts.join(t('vmBuildAgents.separator', ' · '))
}

export type BuildAgentsRowText = { title: string; tag?: string; detail: string }

function setupText(
  model: Extract<BuildAgentsRowModel, { kind: 'setup' }>,
  t: Translate
): BuildAgentsRowText {
  const agent = agentName(model.agent, t)
  const tag =
    model.of > 1
      ? t('vmBuildAgents.stepOf', '{{step}} of {{of}}', { step: model.step, of: model.of })
      : undefined
  const title = t('vmBuildAgents.settingUp', 'Setting up {{agent}}', { agent })
  switch (model.setup.phase) {
    case 'browser':
      return {
        title,
        tag,
        // This row has no field: the code goes in where setup has one (the pane, Settings).
        detail: model.setup.acceptsCode
          ? t(
              'vmBuildAgents.finishInBrowserPaste',
              'Finish in your browser, then paste the code in Settings → Agent accounts.'
            )
          : t('vmBuildAgents.finishInBrowser', 'Finish in your browser')
      }
    case 'preparing':
      return {
        title,
        tag,
        detail: t('vmBuildAgents.preparing', 'Getting {{product}} sign-in ready…', {
          product: productName(model.agent, t)
        })
      }
    case 'device':
      return {
        title,
        tag,
        detail: t('vmBuildAgents.deviceGuard', 'Only continue if you started this sign-in in Orca.')
      }
    case 'paste':
      return {
        title: t('vmBuildAgents.pasteTitle', 'Paste a {{agent}} setup token', { agent }),
        tag,
        detail: t('vmBuildAgents.pasteDetail', 'Paste it in Settings → Agent accounts.')
      }
    case 'saving':
      return {
        title: t('vmBuildAgents.saving', 'Saving to your Orca account…'),
        tag,
        detail: t('vmBuildAgents.savingDetail', 'Every cloud workspace will use it.')
      }
  }
}

/** Line 1 (title + tag) and line 2 for every state but loading, ready and the device code. */
export function buildAgentsRowText(
  model: Exclude<BuildAgentsRowModel, { kind: 'hidden' | 'loading' | 'ready' }>,
  t: Translate
): BuildAgentsRowText {
  switch (model.kind) {
    case 'offer':
      return {
        title: t('vmBuildAgents.signIn', 'Agent sign-in'),
        tag: t('vmBuildAgents.optionalOnce', 'optional · one time'),
        detail: t(
          'vmBuildAgents.offerDetail',
          'Sign in to {{agents}} once. Every cloud workspace uses it.',
          { agents: agentList(model.agents, t) }
        )
      }
    case 'setup':
      return setupText(model, t)
    case 'failed':
      return {
        title: setupFailureCopy(model.agent, model.error, t).title,
        detail: t('vmBuildAgents.stillOpens', 'The workspace still opens.')
      }
    case 'expired':
      return {
        title: t('vmBuildAgents.expired', 'Your {{agent}} sign-in for Orca Cloud expired', {
          agent: agentName(model.agent, t)
        }),
        detail: t(
          'vmBuildAgents.expiredDetailRenew',
          'Renew once. Every cloud workspace picks it up.'
        )
      }
    case 'killSwitch':
      return {
        title: t('vmBuildAgents.agentSignIn', '{{agent}} sign-in', {
          agent: agentName(model.agent, t)
        }),
        tag:
          model.reason === 'paused'
            ? t('vmBuildAgents.paused', 'Orca account sign-in is paused')
            : t('vmBuildAgents.notOffered', 'Signs in for each cloud workspace for now'),
        detail: t('vmBuildAgents.pausedDetail', 'This sign-in stays with this workspace.')
      }
    case 'desktopKey':
      return {
        title: t(
          'cloudAgentSetup.desktopKeys.row',
          '{{agent}}: your API key ••••{{hint}} is only on this computer',
          { agent: formatAgentTypeLabel(model.key.agent), hint: model.key.hint }
        ),
        detail: t(
          'cloudAgentSetup.desktopKeys.detail',
          'Save it to your Orca account to use it in cloud workspaces. It stays outside the sandbox.'
        )
      }
    case 'error':
      return {
        title: t('vmBuildAgents.error', 'Couldn’t check agent sign-in'),
        detail: t(
          'vmBuildAgents.errorDetail',
          'The workspace still opens. Agents can sign in later.'
        )
      }
  }
}

export function deviceHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
