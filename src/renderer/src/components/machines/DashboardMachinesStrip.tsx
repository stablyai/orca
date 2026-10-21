import React, { useMemo, useState } from 'react'
import { Box, ChevronDown, ChevronUp, Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { useMachineSources } from '@/store/machines'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { MachineProviderSnapshot, MachineRecord } from '../../../../shared/machine-inventory'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getMachineDisplayState } from '@/lib/machines/machine-display-state'
import {
  findMachineForHost,
  machineHostKeyForWorktree,
  machineTargetKey,
  type MachineMatch
} from '@/lib/machines/machine-host-match'
import { getMachineLifetimeLabel } from '@/lib/machines/machine-copy'
import { getMachineExpiryWarning } from '@/lib/machines/machine-expiry-warning'
import { useNow } from '@/hooks/use-now'
import { MachineMenuItems } from './MachineMenuItems'
import { MachineStateDot } from './MachineStateLabel'

function agentCountLabel(count: number): string {
  if (count === 0) {
    return translate('auto.components.machines.DashboardMachinesStrip.noAgents', 'no agents')
  }
  return count === 1
    ? translate('auto.components.machines.DashboardMachinesStrip.oneAgent', '1 agent')
    : translate('auto.components.machines.DashboardMachinesStrip.agents', '{{count}} agents', {
        count
      })
}

function MachineCard({
  match,
  agentCount,
  warning
}: {
  match: MachineMatch
  agentCount: number
  warning: string | null
}): React.JSX.Element {
  const meta = [
    match.snapshot.name,
    getMachineLifetimeLabel(match.machine.lifetime),
    agentCountLabel(agentCount)
  ].join(' · ')
  return (
    <div
      data-warning={warning !== null}
      className="min-w-60 max-w-96 shrink-0 rounded-lg border border-border/60 bg-card px-2.5 py-1.5 data-[warning=true]:border-status-warning-border data-[warning=true]:bg-status-warning-background"
    >
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Box className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{match.machine.name}</span>
        <MachineStateDot state={getMachineDisplayState(match.machine.state)} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label={translate(
                'auto.components.machines.DashboardMachinesStrip.actions',
                'Machine actions'
              )}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <MachineMenuItems match={match} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        data-warning={warning !== null}
        title={warning ?? meta}
        className="pl-5 text-xs text-muted-foreground data-[warning=true]:text-status-warning"
      >
        {warning ?? meta}
      </div>
    </div>
  )
}

/**
 * The Agent Dashboard's machines, shown only once a machine exists: one compact card each with
 * its meta line, and main's pre-expiry warning in place of it when unsaved work is at risk.
 */
export function DashboardMachinesStrip({
  cards
}: {
  cards: readonly DashboardCard[]
}): React.JSX.Element | null {
  const sources = useMachineSources()
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  const expiryWarnings = useAppStore((state) => state.machineExpiryWarnings)
  const [collapsed, setCollapsed] = useState(false)

  const machines = useMemo(
    () =>
      sources.self.flatMap((snapshot: MachineProviderSnapshot) =>
        snapshot.machines
          .filter(
            (machine: MachineRecord) => machine.state !== 'gone' && machine.state !== 'archived'
          )
          .map((machine): MachineMatch => ({ snapshot, machine, environmentId: null }))
      ),
    [sources]
  )

  // Why: the expiry warning is the only relative copy here, so no machines means no clock.
  const now = useNow(60_000, machines.length > 0)
  const agentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    for (const card of cards) {
      const worktree = findWorktreeById(worktreesByRepo, card.worktreeId)
      const match = worktree
        ? findMachineForHost(
            machineHostKeyForWorktree(worktree, repoById.get(worktree.repoId)),
            sources
          )
        : null
      if (match) {
        const key = machineTargetKey({
          providerKey: match.snapshot.providerKey,
          machineId: match.machine.id
        })
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }, [cards, repos, sources, worktreesByRepo])
  if (machines.length === 0) {
    return null
  }
  return (
    <section className="flex shrink-0 items-center gap-3 px-4 pt-3">
      <span className="flex shrink-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('auto.components.machines.DashboardMachinesStrip.title', 'Machines')}
        <span className="rounded-full bg-muted px-1.5 font-normal tabular-nums tracking-normal">
          {machines.length}
        </span>
      </span>
      {collapsed ? null : (
        <div className="scrollbar-sleek flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5">
          {machines.map((match) => {
            const key = machineTargetKey({
              providerKey: match.snapshot.providerKey,
              machineId: match.machine.id
            })
            return (
              <MachineCard
                key={key}
                match={match}
                agentCount={agentCounts.get(key) ?? 0}
                warning={getMachineExpiryWarning(match, expiryWarnings[key], now)}
              />
            )
          })}
        </div>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="ml-auto"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={
          collapsed
            ? translate('auto.components.machines.DashboardMachinesStrip.expand', 'Show machines')
            : translate('auto.components.machines.DashboardMachinesStrip.collapse', 'Hide machines')
        }
      >
        {collapsed ? <ChevronDown /> : <ChevronUp />}
      </Button>
    </section>
  )
}
