import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { parseStructuredLaunchSeedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { isAgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentPickerDefaultSettings } from '../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { modelMenuUsesHostCatalog } from '../../../../shared/agent-session/options/model-menu-source'
import {
  hostModelMenuCatalog,
  type HostModelMenuSnapshot
} from '@/runtime/native-chat/model-catalogs/host-model-menu-catalog'

export function agentPickerModelCatalogReads(input: {
  target: RuntimeClientTarget
  selector?: string
  nativeRuntime: boolean
  platform?: NodeJS.Platform
  settings: AgentPickerDefaultSettings | null | undefined
  serverSettings?: () => Promise<AgentPickerDefaultSettings | undefined>
}) {
  const scope = (entry: AgentPickerEntry) => ({
    target: input.target,
    agent: entry.agent,
    ...(input.selector ? { worktree: input.selector } : {})
  })
  const eligible = async (entry: AgentPickerEntry) => {
    const server = input.serverSettings ? await input.serverSettings() : input.settings
    if (input.serverSettings && !server) {
      return false
    }
    return modelMenuUsesHostCatalog({
      nativeRuntime: input.nativeRuntime,
      registered: entry.catalogRead !== 'unsupported',
      commandOverride:
        input.settings?.agentCmdOverrides?.[entry.agent] ??
        server?.agentCmdOverrides?.[entry.agent],
      serverCommandOverride: server?.agentCmdOverrides?.[entry.agent],
      paired: input.target.kind === 'environment',
      platform: input.platform
    })
  }
  return {
    catalog: async (entry: AgentPickerEntry) =>
      (await eligible(entry))
        ? hostModelMenuCatalog(scope(entry)).read()
        : { origin: 'unknown' as const },
    observeCatalog: (
      entry: AgentPickerEntry,
      publish: (snapshot: HostModelMenuSnapshot & { invalidated?: boolean }) => void
    ) => {
      if (entry.catalogRead === 'unsupported') {
        return () => {}
      }
      let disposed = false
      let unsubscribe = () => {}
      void eligible(entry).then((canRead) => {
        if (!canRead || disposed) {
          return
        }
        const owner = hostModelMenuCatalog(scope(entry))
        let generation = owner.snapshot.generation
        unsubscribe = owner.subscribe(() => {
          const invalidated = generation !== owner.snapshot.generation
          generation = owner.snapshot.generation
          publish({ ...owner.snapshot, invalidated })
        })
      })
      return () => {
        disposed = true
        unsubscribe()
      }
    }
  }
}

export async function readAgentPickerLaunchSupport(
  target: RuntimeClientTarget,
  selector: string | undefined,
  agent: AgentPickerEntry['agent']
): Promise<AgentPickerEntry['structured'] | undefined> {
  if (!selector) {
    return undefined
  }
  const support = await callStructuredAgentSession<{ seedOptions?: Record<string, string> }>(
    target,
    'agentSession.createSupport',
    { worktree: selector, agent }
  )
  const parsed = parseStructuredLaunchSeedOptions(support?.seedOptions)
  if (!parsed) {
    return undefined
  }
  const { model, permissionMode, ...options } = parsed
  return {
    ...(model ? { model } : {}),
    options,
    ...(isAgentChatPermissionChoice(permissionMode) ? { permissionMode } : {})
  }
}
