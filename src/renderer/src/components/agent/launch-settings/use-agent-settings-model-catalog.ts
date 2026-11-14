import { useEffect, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  HOST_MODEL_CATALOG_ACCOUNT_SETTINGS,
  withoutUnprovenNewLaunchDefault
} from '../../../../../shared/agent-session/options/model-catalog/host-model-catalog-snapshot-rules'
import { sourceControlActionAgentPicksModel } from '../../../../../shared/source-control/ai/recipes/source-control-action-options'
import {
  hostModelCatalogGeneration,
  readHostModelCatalogSnapshot,
  subscribeHostModelCatalogForgotten
} from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { subscribeHostAgentLaunchSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { structuredAgentSessionHostKey } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { useAppStore } from '@/store'
import {
  agentPickerListsCliModels,
  readAgentPickerCliModelCatalog
} from '../agent-launch-picker-cli-model-catalog'
import { resolveWorktreeModelDiscoveryRuntime } from '../../native-chat/session/options/catalog/native-chat-session-option-discovery'

const SETTINGS_LAUNCH = { newLaunch: true, seedsModel: true }

/** The host's account models for a Settings default. `usesSeedModels` says the release's list stands in. */
export function useAgentSettingsModelCatalog(
  agent: TuiAgent,
  target: RuntimeClientTarget | null
): { catalog: AgentSessionModelCatalogResult | undefined; usesSeedModels: boolean } {
  const key = target ? `${structuredAgentSessionHostKey(target)}\u0000${agent}` : null
  // Same array until one changes: a new account or command lists different models.
  const accountSettings = useAppStore(
    useShallow((state) => HOST_MODEL_CATALOG_ACCOUNT_SETTINGS.map((name) => state.settings?.[name]))
  )
  // A host can change account with no setting changing here, such as a paired host reconnecting.
  const readGeneration = (): number => (target ? hostModelCatalogGeneration(target) : 0)
  const generation = useSyncExternalStore(subscribeHostModelCatalogForgotten, readGeneration)
  // A paired host's command and environment live in its own settings; re-read, keeping the shown list meanwhile.
  const [hostRevision, setHostRevision] = useState(0)
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const isLocal = target?.kind === 'local'
  useEffect(
    () =>
      environmentId
        ? subscribeHostAgentLaunchSettings((owner) => {
            if (owner.environmentId === environmentId) {
              setHostRevision((revision) => revision + 1)
            }
          })
        : undefined,
    [environmentId]
  )
  const [answer, setAnswer] = useState<{
    key: string
    accountSettings: readonly unknown[]
    generation: number
    catalog: AgentSessionModelCatalogResult | undefined
  } | null>(null)
  useEffect(() => {
    // Rebuilt from primitives: callers pass a new target object every render.
    const readTarget: RuntimeClientTarget | null = environmentId
      ? { kind: 'environment', environmentId }
      : isLocal
        ? { kind: 'local' }
        : null
    if (!readTarget || !key || !sourceControlActionAgentPicksModel(agent)) {
      return
    }
    let stale = false
    // Like the launch picker, an agent with no structured chat lists through this machine's CLI;
    // a workspace-less read can't route that to another host, so other hosts keep the seed.
    const cliRuntime =
      isLocal && agentPickerListsCliModels({ agent })
        ? resolveWorktreeModelDiscoveryRuntime(useAppStore.getState(), null)
        : null
    // Not recorded in the new-chat snapshot: an account answer there would drop newer workspace answers.
    // Old hosts refuse waitForListing, so wait only once the host says a listing is running.
    const fetchCatalog = (wait: boolean): Promise<AgentSessionModelCatalogResult> =>
      cliRuntime
        ? readAgentPickerCliModelCatalog(agent, cliRuntime)
        : callStructuredAgentSession<AgentSessionModelCatalogResult>(
            readTarget,
            'agentSession.modelCatalog',
            wait ? { agent, waitForListing: true } : { agent }
          )
    const read = (wait: boolean): void => {
      void fetchCatalog(wait)
        .then((catalog) => {
          if (stale) {
            return
          }
          setAnswer({ key, accountSettings, generation, catalog })
          if (catalog.waitExpired || catalog.listingInProgress) {
            read(true)
          }
        })
        // Why not the snapshot: an unanswered read can't vouch for an older list.
        .catch(() => {
          if (!stale) {
            setAnswer({ key, accountSettings, generation, catalog: undefined })
          }
        })
    }
    read(false)
    return () => {
      stale = true
    }
  }, [agent, key, environmentId, isLocal, accountSettings, generation, hostRevision])
  const settled =
    answer?.key === key &&
    answer.accountSettings === accountSettings &&
    answer.generation === generation
      ? answer
      : null
  // Why not the snapshot once answered: it serves new chats, so it refuses workspace-scoped lists.
  const catalog = settled
    ? settled.catalog && withoutUnprovenNewLaunchDefault(settled.catalog)
    : target
      ? readHostModelCatalogSnapshot(target, agent, SETTINGS_LAUNCH)
      : undefined
  const listed = catalog && catalog.origin !== 'unknown' && catalog.models.length > 0
  return { catalog, usesSeedModels: !listed && (!target || settled !== null) }
}
