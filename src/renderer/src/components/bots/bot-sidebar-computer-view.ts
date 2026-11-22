import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { z } from 'zod'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { uiCollator } from '@/i18n/ui-intl-formatters'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { HostKeyedBotSidebarEntry } from './bot-sidebar-entry-keys'

const STORAGE_KEY = 'orca.bots.computerView'
const COMPUTER_SORT: Intl.CollatorOptions = { sensitivity: 'base' }
export const BOT_COMPUTER_NAME_LIMIT = 60
const computerAssignment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), hostId: z.string(), name: z.string() }),
  z.object({
    kind: z.literal('named'),
    name: z.string().trim().min(1).max(BOT_COMPUTER_NAME_LIMIT)
  })
])
export type BotComputerAssignment = z.infer<typeof computerAssignment>
const viewSchema = z.object({
  enabled: z.boolean(),
  assignments: z.record(z.string(), computerAssignment),
  folded: z.array(z.string())
})
type ComputerView = z.infer<typeof viewSchema>
const DEFAULT_VIEW: ComputerView = { enabled: false, assignments: {}, folded: [] }

function readView(fallback: ComputerView): ComputerView {
  try {
    return (
      viewSchema.safeParse(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).data ??
      DEFAULT_VIEW
    )
  } catch {
    return fallback
  }
}

type ComputerSection = { kind: 'computer'; id: string; name: string; folded: boolean }
export type ComputerListRow =
  | HostKeyedBotSidebarEntry
  | ComputerSection
  | { kind: 'group-heading'; id: string }

function computerKey(assignment: BotComputerAssignment): string {
  return assignment.kind === 'host'
    ? `computer:host:${assignment.hostId}`
    : `computer:name:${assignment.name.normalize('NFC').toLowerCase()}`
}

function computerFor(
  entry: Extract<HostKeyedBotSidebarEntry, { kind: 'bot' }>,
  assignments: ComputerView['assignments'],
  hostNames: ReadonlyMap<string, string>
): BotComputerAssignment {
  const assignment = assignments[entry.id]
  if (assignment?.kind === 'named') {
    return assignment
  }
  const hostId = assignment?.hostId ?? entry.bot.hostId
  return { kind: 'host', hostId, name: hostNames.get(hostId) ?? assignment?.name ?? hostId }
}

function groupRows(
  entries: readonly HostKeyedBotSidebarEntry[],
  { assignments, folded }: ComputerView,
  hostNames: ReadonlyMap<string, string>,
  collator: Intl.Collator
): ComputerListRow[] {
  const sections = new Map<string, { name: string; entries: HostKeyedBotSidebarEntry[] }>()
  const groups: HostKeyedBotSidebarEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'group') {
      groups.push(entry)
    } else {
      const computer = computerFor(entry, assignments, hostNames)
      const key = computerKey(computer)
      const section = sections.get(key) ?? { name: computer.name, entries: [] }
      section.entries.push(entry)
      sections.set(key, section)
    }
  }
  const rows: ComputerListRow[] = []
  for (const [id, section] of [...sections].sort((a, b) =>
    collator.compare(a[1].name, b[1].name)
  )) {
    const isFolded = folded.includes(id)
    rows.push({ kind: 'computer', id, name: section.name, folded: isFolded })
    if (!isFolded) {
      rows.push(...section.entries)
    }
  }
  if (groups.length > 0) {
    rows.push({ kind: 'group-heading', id: 'computer:group-heading' }, ...groups)
  }
  return rows
}

export function useBotSidebarComputerView(
  entries: readonly HostKeyedBotSidebarEntry[],
  bots: readonly Bot[]
) {
  const t = useTranslate()
  const locale = useIntlLocale()
  const available = !isPairedWebClientWindow()
  const [view, setView] = useState(() => readView(DEFAULT_VIEW))
  const enabled = available && view.enabled
  const hostIds = useAppStore(
    useShallow((state) =>
      enabled
        ? [
            ...new Set<ExecutionHostId>([
              LOCAL_EXECUTION_HOST_ID,
              ...state.runtimeEnvironments.map(({ id }) => toRuntimeExecutionHostId(id)),
              ...bots.map(({ hostId }) => hostId)
            ])
          ]
        : []
    )
  )
  const labels = useAppStore(
    useShallow((state) => hostIds.map((id) => selectExecutionHostDisplayLabel(state, id, { t })))
  )
  const hostNames = useMemo(
    () => new Map<string, string>(hostIds.map((id, index) => [id, labels[index]!])),
    [hostIds, labels]
  )
  const rows = useMemo(
    () =>
      enabled ? groupRows(entries, view, hostNames, uiCollator(COMPUTER_SORT, locale)) : entries,
    [enabled, entries, hostNames, locale, view]
  )
  useEffect(() => {
    if (!available) {
      return
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY || event.key === null) {
        setView(readView(DEFAULT_VIEW))
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [available])
  const update = useCallback(
    (change: (current: ComputerView) => ComputerView): void => {
      const current = readView(view)
      const next = change(current)
      if (next === current) {
        return
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch (error) {
        console.error('Could not save the Bots computer view', error)
      }
      setView(next)
    },
    [view]
  )

  return {
    available,
    enabled,
    rows,
    hostNames,
    assignments: view.assignments,
    setEnabled: (next: boolean) => update((current) => ({ ...current, enabled: next })),
    toggle: (id: string) =>
      update((current) => ({
        ...current,
        folded: current.folded.includes(id)
          ? current.folded.filter((key) => key !== id)
          : [...current.folded, id]
      })),
    reveal: (entryId: string) => {
      const entry = enabled ? entries.find((candidate) => candidate.id === entryId) : undefined
      if (entry?.kind === 'bot') {
        update((current) => {
          const key = computerKey(computerFor(entry, current.assignments, hostNames))
          return current.folded.includes(key)
            ? { ...current, folded: current.folded.filter((id) => id !== key) }
            : current
        })
      }
    },
    assign: (
      entry: Extract<HostKeyedBotSidebarEntry, { kind: 'bot' }>,
      assignment: BotComputerAssignment | null
    ) =>
      update((current) => {
        const assignments = { ...current.assignments }
        if (assignment) {
          assignments[entry.id] = assignment
        } else {
          delete assignments[entry.id]
        }
        const key = computerKey(computerFor(entry, assignments, hostNames))
        return { ...current, assignments, folded: current.folded.filter((id) => id !== key) }
      })
  }
}
