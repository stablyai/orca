// B2: the setup panel's Team row when the user is on their personal account and a team they're on
// already has a plan. Switching uses the account menu's switcher (no browser trip); several planned
// teams become a menu. The panel renders `step` as its Team row and `action` in that row's slot.
import React from 'react'
import { ChevronDown, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import {
  switchActiveTeam,
  usePendingTeamSwitch
} from '@/components/sidebar/account-menu/switch-active-team'
import { useSwitchToPlannedTeam, type PlannedTeam } from './use-switch-to-planned-team'

function CloudSetupSwitchTeamAction({
  teams,
  onSwitch
}: {
  teams: readonly PlannedTeam[]
  /** Fixture/test seam; defaults to the account menu's switcher. */
  onSwitch?: (team: PlannedTeam) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const busy = usePendingTeamSwitch() !== null
  const first = teams[0]
  if (!first) {
    return null
  }
  const switchTo = (team: PlannedTeam): void => {
    if (onSwitch) {
      onSwitch(team)
      return
    }
    void switchActiveTeam({ orgId: team.orgId, label: team.name, pendingKey: team.orgId, t })
  }
  if (teams.length === 1) {
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="mt-1"
        aria-busy={busy || undefined}
        onClick={busy ? undefined : () => switchTo(first)}
      >
        <Users aria-hidden />
        {t('components.newWorkspace.cloudSetup.switchTo', 'Switch to {{team}}', {
          team: first.name
        })}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-1"
          aria-busy={busy || undefined}
        >
          <Users aria-hidden />
          {t('components.newWorkspace.cloudSetup.switchTeam', 'Switch team')}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {teams.map((team) => (
          <DropdownMenuItem
            key={team.orgId}
            disabled={busy}
            onSelect={() => switchTo(team)}
            title={team.name}
          >
            <span className="min-w-0 flex-1 truncate">{team.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type CloudSetupSwitchTeam = {
  /** The Team row (state 'needed') with B2's wording as its detail. */
  step: CloudSetupStep
  /** The row's action: "Switch to <team>", or a menu of teams. */
  action: React.ReactNode
  /** Start stays aria-disabled with this reason (tooltip and description) until the switch. */
  startHeldReason: string
}

/** Copy and pieces for B2 once the planned teams are known; null when B2 doesn't apply. */
function useCloudSetupSwitchTeamFor(
  teams: readonly PlannedTeam[],
  onSwitch?: (team: PlannedTeam) => void
): CloudSetupSwitchTeam | null {
  const t = useTranslate()
  const first = teams[0]
  if (!first) {
    return null
  }
  const lead = t(
    'components.newWorkspace.cloudSetup.teamRequired',
    'Cloud workspaces belong to a team.'
  )
  const detail =
    teams.length === 1
      ? t(
          'components.newWorkspace.cloudSetup.teamHasPlan',
          '{{team}} has a Team plan. Switch to start this workspace there.',
          { team: first.name }
        )
      : t(
          'components.newWorkspace.cloudSetup.teamsHavePlans',
          '{{teams}} have a Team plan. Switch to one to start this workspace there.',
          { teams: teams.map((team) => team.name).join(', ') }
        )
  return {
    step: { id: 'team', state: 'needed', detail: `${lead} ${detail}` },
    action: <CloudSetupSwitchTeamAction teams={teams} onSwitch={onSwitch} />,
    startHeldReason:
      teams.length === 1
        ? t('components.newWorkspace.cloudSetup.switchFirst', 'Switch to {{team}} first', {
            team: first.name
          })
        : t('components.newWorkspace.cloudSetup.switchTeamFirst', 'Switch to a team first')
  }
}

/**
 * The setup rows with B2's Team row in place of the plan row, or null when B2 doesn't apply:
 * only a signed-in account whose own plan row is still open (switching is the fix, not buying).
 */
export function applySwitchTeamStep(
  steps: readonly CloudSetupStep[],
  teamStep: CloudSetupStep
): CloudSetupStep[] | null {
  const plan = steps.find((step) => step.id === 'plan')
  const signedIn = steps.some((step) => step.id === 'account' && step.state === 'done')
  if (!plan || plan.state === 'done' || !signedIn) {
    return null
  }
  return steps.map((step) => (step.id === 'plan' ? teamStep : step))
}

/**
 * B2 for the composer: pass `enabled` while Orca Cloud is picked. Null until a planned team is
 * known (or when signed out, already on a team, or billing can't say).
 */
export function useCloudSetupSwitchTeam(enabled: boolean): CloudSetupSwitchTeam | null {
  return useCloudSetupSwitchTeamFor(useSwitchToPlannedTeam(enabled))
}
