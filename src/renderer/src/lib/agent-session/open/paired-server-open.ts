// Opening a worker this computer started on a paired server: whom to ask, and the notices that name that server.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { StructuredSessionOpenResult } from '../../../../../shared/agent-session/view/open-structured-agent-session'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredSessionOpenFeedback } from './activate-ai-vault-structured-session'

/** The paired server this computer's host says runs the party; a paired host's answer names its own pairings. */
export function pairedServerToAsk(
  result: StructuredSessionOpenResult,
  owner: RuntimeClientTarget
): string | undefined {
  return owner.kind === 'local' && result.kind === 'failed' && result.failure.reason === 'unknown'
    ? result.failure.pairedServer
    : undefined
}

/** The server's name while this desktop is paired with it; null once it is not. Before the list
 *  of paired servers loads, its ID stands in, so the open still asks it. */
export function pairedServerName(environmentId: string): string | null {
  const { runtimeEnvironments, runtimeEnvironmentCatalogHydrated } = useAppStore.getState()
  const known = runtimeEnvironments.find((environment) => environment.id === environmentId)
  return known?.name ?? (runtimeEnvironmentCatalogHydrated ? null : environmentId)
}

export const pairedServerOpenText = {
  unpaired: (agent?: string) =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.pairedServerUnpaired',
      "{{agent}} runs on a computer this Orca is no longer paired with, so it can't open it.",
      {
        agent:
          agent || translate('auto.lib.activateAiVaultStructuredSession.thisAgent', 'This agent')
      }
    ),
  unreachable: (server: string, agent?: string) =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.pairedServerUnreachable',
      "Orca couldn't reach {{server}} to open {{agent}}.",
      {
        server,
        agent: agent || translate('auto.lib.activateAiVaultStructuredSession.theAgent', 'the agent')
      }
    ),
  gone: (server: string, agent?: string) =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.pairedServerGone',
      '{{agent}} is no longer running on {{server}}.',
      {
        server,
        agent:
          agent || translate('auto.lib.activateAiVaultStructuredSession.thisAgent', 'This agent')
      }
    ),
  elsewhere: (server: string, agent?: string) =>
    translate(
      'auto.lib.activateAiVaultStructuredSession.pairedServerElsewhere',
      "{{agent}} runs on a computer paired with {{server}}, not with this one, so Orca can't open it here.",
      {
        server,
        agent:
          agent || translate('auto.lib.activateAiVaultStructuredSession.thisAgent', 'This agent')
      }
    )
}

/** The opener's notices for an open on a paired server: what can't be reached or is gone names that server. */
export function pairedServerOpenFeedback(
  base: StructuredSessionOpenFeedback,
  server: string,
  agent: string | undefined
): StructuredSessionOpenFeedback {
  return {
    ...base,
    unavailable: (name, context) =>
      context?.starting
        ? base.unavailable(name, context)
        : toast.error(pairedServerOpenText.unreachable(server, name || agent)),
    // The server answered and finds no chat or terminal for it.
    notLocated: (name) => toast.error(pairedServerOpenText.gone(server, name || agent)),
    terminalGone: () => toast.error(pairedServerOpenText.gone(server, agent))
  }
}

/** Opens on the paired server through `open`. A server no longer paired is never called, and one
 *  that can't be reached says so by name: neither leaves a Retry that can't succeed. */
export async function openOnPairedServer(
  environmentId: string,
  agent: string | undefined,
  base: StructuredSessionOpenFeedback,
  open: (
    host: RuntimeClientTarget,
    feedback: StructuredSessionOpenFeedback
  ) => Promise<StructuredSessionOpenResult>
): Promise<StructuredSessionOpenResult> {
  const server = pairedServerName(environmentId)
  const failed = { kind: 'failed', failure: { reason: 'unknown', beforeEffects: true } } as const
  if (!server) {
    toast.error(pairedServerOpenText.unpaired(agent))
    return failed
  }
  try {
    const opened = await open(
      { kind: 'environment', environmentId },
      pairedServerOpenFeedback(base, server, agent)
    )
    if (opened.kind !== 'terminal') {
      return opened
    }
    // A terminal the server names another computer for is on that server's own pairing, which this
    // desktop can't address; any other is the server's own.
    if (opened.environmentId) {
      toast.error(pairedServerOpenText.elsewhere(server, agent))
      return failed
    }
    return { ...opened, environmentId }
  } catch {
    // The call there failed before any answer, so nothing has said so yet.
    toast.error(pairedServerOpenText.unreachable(server, agent))
    return failed
  }
}

/** A terminal this computer's host placed on a paired server, gone there, is named so; nothing here
 *  is looked up for it. */
export function pairedServerTerminalFeedback<T extends { gone?: () => void }>(
  feedback: T,
  host: RuntimeClientTarget,
  result: { environmentId?: string },
  agent: string | undefined
): T {
  const server =
    host.kind === 'local' && result.environmentId ? pairedServerName(result.environmentId) : null
  return server
    ? { ...feedback, gone: () => toast.error(pairedServerOpenText.gone(server, agent)) }
    : feedback
}
