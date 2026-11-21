import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  applyAgentCopy,
  captureAgentCopy,
  createAgentCopy,
  MAX_AGENT_COPIES,
  normalizeAgentCopies,
  type AgentCopy
} from '../../../../../../shared/agent-launch/catalog/agent-copies'
import {
  agentLaunchSettingsMutationUpdates,
  type AgentLaunchSettingsMutation
} from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import { wholeAgentEnvironmentUpdates } from '../../../../../../shared/agent-launch/choices/agent-launch-permission-updates'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'

type LocalSettings = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** This computer's agent copies and their writes. Copies keep local environments, so a paired
 *  host's page has none. Every write starts from the last saved list, one after another, so two
 *  edits in flight never overwrite each other. */
export function useAgentCopySettings(local: LocalSettings | undefined) {
  const t = useTranslate()
  const tail = useRef<Promise<void> | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const list = local ? normalizeAgentCopies(local.settings.agentCopies) : []
  const platform = (): NodeJS.Platform => window.api.platform.get().platform

  const write = (
    compute: (copies: AgentCopy[], settings: GlobalSettings) => AgentCopy[] | null
  ): Promise<void> => {
    if (!local) {
      return Promise.resolve()
    }
    const run = async (): Promise<void> => {
      const latest = useAppStore.getState().settings ?? local.settings
      const next = compute(normalizeAgentCopies(latest.agentCopies), latest)
      if (next) {
        await local.updateSettings({ agentCopies: next })
      }
    }
    const operation = (tail.current ?? Promise.resolve())
      .catch(() => {})
      .then(run)
      .catch((error: unknown) => {
        toast.error(
          t('settings.agents.copySaveFailed', 'The agent copy could not be saved. Try again.')
        )
        throw error
      })
    tail.current = operation
    return operation
  }

  /** Replaces copy `id` with what `change` makes of the latest saved one; null deletes it. */
  const update = (
    id: string,
    change: (copy: AgentCopy, settings: GlobalSettings) => AgentCopy | null
  ): Promise<void> =>
    write((copies, settings) => {
      const copy = copies.find((entry) => entry.id === id)
      if (!copy) {
        return null
      }
      const next = change(copy, settings)
      return copies.flatMap((entry) => (entry.id !== id ? [entry] : next ? [next] : []))
    })

  /** Runs one of the agent's own edits on the copy's settings and keeps the result as the copy. */
  const editAs =
    (id: string) =>
    (
      compute: (settings: GlobalSettings, platform: NodeJS.Platform) => Partial<GlobalSettings>
    ): Promise<void> =>
      update(id, (copy, settings) => {
        const view = applyAgentCopy(settings, copy)
        return captureAgentCopy(copy, { ...view, ...compute(view, platform()) })
      })

  /** A new copy of `agent`, or of `from` with its values; refused at the copy limit. */
  const duplicate = (agent: { id: TuiAgent; label: string }, from?: AgentCopy): void => {
    let made: AgentCopy | null = null
    void write((copies, settings) => {
      if (copies.length >= MAX_AGENT_COPIES) {
        toast.error(
          t(
            'settings.agents.copyLimit',
            'Orca keeps up to {{count}} agent copies. Delete one to make another.',
            { count: MAX_AGENT_COPIES }
          )
        )
        return null
      }
      const name = t('settings.agents.copyDefaultName', '{{agent}} copy', {
        agent: from?.name ?? agent.label
      })
      const source = from ? applyAgentCopy(settings, from) : settings
      made = createAgentCopy(agent.id, name, { ...source, agentCopies: copies })
      return [...copies, made]
    }).then(() => {
      const copy: AgentCopy | null = made
      if (copy) {
        setCreated(copy.id)
        toast.success(
          t('settings.agents.copyCreated', 'Saved {{name}} as {{id}}.', {
            name: copy.name,
            id: copy.id
          })
        )
      }
    })
  }

  return {
    list,
    created,
    duplicate,
    mutate:
      (id: string) =>
      (mutation: AgentLaunchSettingsMutation): Promise<void> =>
        editAs(id)((view, hostPlatform) =>
          agentLaunchSettingsMutationUpdates(view, mutation, hostPlatform)
        ),
    saveEnvironment:
      (id: string) =>
      (agent: TuiAgent, requested: Record<string, string>): Promise<void> =>
        editAs(id)((view, hostPlatform) =>
          wholeAgentEnvironmentUpdates(view, agent, requested, hostPlatform)
        ),
    rename: (id: string, identity: { name: string; id: string }): Promise<void> =>
      update(id, (copy) => ({ ...copy, ...identity })),
    setChat: (id: string, chat: boolean): Promise<void> =>
      update(id, (copy) => ({ ...copy, chat })),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      update(id, ({ disabled: _disabled, ...copy }) =>
        enabled ? copy : { ...copy, disabled: true }
      ),
    remove: (id: string): Promise<void> => update(id, () => null)
  }
}
