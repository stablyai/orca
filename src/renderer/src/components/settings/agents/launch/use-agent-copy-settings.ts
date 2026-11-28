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

/** An ID change one queued write saved: later writes that were queued before it follow it. */
type IdChange = { seq: number; from: string; to: string }

/** How a queued write reads the ids its caller saw, and records an ID change it makes. */
type WriteIds = {
  resolve: (id: string) => string
  moved: (from: string, to: string) => void
}

/** This computer's agent copies and their writes. Copies keep local environments, so a paired
 *  host's page has none. Every write starts from the last saved list, one after another, so two
 *  edits in flight never overwrite each other. */
export function useAgentCopySettings(local: LocalSettings | undefined) {
  const t = useTranslate()
  const tail = useRef<Promise<void> | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  // Writes queued and finished so far, and the ID changes saved by writes still in the queue.
  const queued = useRef(0)
  const settled = useRef(0)
  const idChanges = useRef<IdChange[]>([])
  const list = local ? normalizeAgentCopies(local.settings.agentCopies) : []
  const platform = (): NodeJS.Platform => window.api.platform.get().platform

  const write = (
    compute: (copies: AgentCopy[], settings: GlobalSettings, ids: WriteIds) => AgentCopy[] | null
  ): Promise<void> => {
    if (!local) {
      return Promise.resolve()
    }
    // The caller names copies by their saved ids. ID changes queued before this write, and not
    // saved yet, move those ids before it runs; nothing queued after it ever does.
    const after = settled.current
    const upTo = queued.current
    const seq = ++queued.current
    const ids: WriteIds = {
      resolve: (id) =>
        idChanges.current
          .filter((change) => change.seq > after && change.seq <= upTo)
          .reduce((current, change) => (change.from === current ? change.to : current), id),
      moved: () => {}
    }
    const run = async (): Promise<void> => {
      let moved: IdChange | null = null
      ids.moved = (from, to) => {
        moved = { seq, from, to }
      }
      const latest = useAppStore.getState().settings ?? local.settings
      const next = compute(normalizeAgentCopies(latest.agentCopies), latest, ids)
      if (next) {
        await local.updateSettings({ agentCopies: next })
        if (moved) {
          idChanges.current.push(moved)
        }
      }
    }
    // Saved or failed, this write is done before the next one starts.
    const settle = (): void => {
      settled.current = seq
      if (settled.current === queued.current) {
        idChanges.current = []
      }
    }
    const operation = (tail.current ?? Promise.resolve())
      .catch(() => {})
      .then(run)
      .finally(settle)
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
    change: (
      copy: AgentCopy,
      settings: GlobalSettings,
      ids: WriteIds
    ) => AgentCopy | null | undefined
  ): Promise<void> =>
    write((copies, settings, ids) => {
      const target = ids.resolve(id)
      const copy = copies.find((entry) => entry.id === target)
      if (!copy) {
        throw new Error(`Unknown agent copy "${target}"`)
      }
      const next = change(copy, settings, ids)
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
    void write((copies, settings, ids) => {
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
      const from = fromId ? copies.find((copy) => copy.id === ids.resolve(fromId)) : undefined
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
    changeId: (id: string, nextId: string): Promise<void> =>
      update(id, (copy, settings, ids) => {
        if (normalizeAgentCopies(settings.agentCopies).some((other) => other.id === nextId)) {
          toast.error(t('settings.agents.copyIdTaken', 'Another copy has this ID.'))
          return undefined
        }
        ids.moved(copy.id, nextId)
        return { ...copy, id: nextId }
      }),
    setChat: (id: string, chat: boolean): Promise<void> =>
      update(id, (copy) => ({ ...copy, chat })),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      update(id, ({ disabled: _disabled, ...copy }) =>
        enabled ? copy : { ...copy, disabled: true }
      ),
    remove: (id: string): Promise<void> =>
      write((copies, _settings, ids) => copies.filter((copy) => copy.id !== ids.resolve(id)))
  }
}
