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
  // Ids renamed while edits made under the old id were still queued, so those edits follow.
  const renamed = useRef(new Map<string, string>())
  const current = (id: string): string => {
    let next = id
    for (let hops = 0; renamed.current.has(next) && hops < 64; hops++) {
      next = renamed.current.get(next) ?? next
    }
    return next
  }
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

  /** Replaces copy `id` with what `change` makes of the latest saved one; null deletes it, and
   *  undefined leaves it as it is. An edit to a copy that is gone fails visibly. */
  const update = (
    id: string,
    change: (copy: AgentCopy, settings: GlobalSettings) => AgentCopy | null | undefined
  ): Promise<void> =>
    write((copies, settings) => {
      const target = current(id)
      const copy = copies.find((entry) => entry.id === target)
      if (!copy) {
        throw new Error(`Unknown agent copy "${target}"`)
      }
      const next = change(copy, settings)
      if (next === undefined) {
        return null
      }
      return copies.flatMap((entry) => (entry.id !== target ? [entry] : next ? [next] : []))
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

  /** A new copy of `agent`, or of copy `fromId` with its latest saved values; refused at the
   *  copy limit. */
  const duplicate = (agent: { id: TuiAgent; label: string }, fromId?: string): void => {
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
      const from = fromId ? copies.find((copy) => copy.id === current(fromId)) : undefined
      if (fromId && !from) {
        // Never fall back to the agent's own values for a copy deleted in the meantime.
        toast.error(
          t('settings.agents.copySourceGone', 'That copy was deleted, so nothing was duplicated.')
        )
        return null
      }
      const name = t('settings.agents.copyDefaultName', '{{agent}} copy', {
        agent: from?.name ?? agent.label
      })
      const source = from ? applyAgentCopy(settings, from) : settings
      made = createAgentCopy(agent.id, name, { ...source, agentCopies: copies })
      // The new copy may take an id an earlier rename vacated; that rename no longer forwards it.
      renamed.current.delete(made.id)
      // Set before the save lands, so the new card arrives open.
      setCreated(made.id)
      return [...copies, made]
    }).then(() => {
      const copy: AgentCopy | null = made
      if (copy) {
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
    rename: (id: string, name: string): Promise<void> => update(id, (copy) => ({ ...copy, name })),
    /** Gives the copy a new id; an id another copy took in the meantime leaves it unchanged. */
    changeId: (id: string, nextId: string): Promise<void> => {
      let moved: string | null = null
      const operation = update(id, (copy, settings) => {
        if (normalizeAgentCopies(settings.agentCopies).some((other) => other.id === nextId)) {
          toast.error(t('settings.agents.copyIdTaken', 'Another copy has this ID.'))
          return undefined
        }
        moved = copy.id
        return { ...copy, id: nextId }
      })
      // Registered before any later edit is queued, so that edit already follows the new id.
      return operation.then(() => {
        if (moved) {
          // The new id now names this copy, so no older rename may still forward it elsewhere.
          renamed.current.delete(nextId)
          renamed.current.set(moved, nextId)
        }
      })
    },
    setChat: (id: string, chat: boolean): Promise<void> =>
      update(id, (copy) => ({ ...copy, chat })),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      update(id, ({ disabled: _disabled, ...copy }) =>
        enabled ? copy : { ...copy, disabled: true }
      ),
    remove: (id: string): Promise<void> =>
      write((copies) => copies.filter((copy) => copy.id !== current(id)))
  }
}
