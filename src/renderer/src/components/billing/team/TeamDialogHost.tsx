import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { OrcaBillingOpenResult } from '../../../../../shared/orca-billing'
import type { OrcaProfileOrgCreateResult } from '../../../../../shared/orca-org-management'
import { openFailureCopy } from '../plan-billing-copy'
import { openPlansPage } from '../plans/plans-page-store'
import { useOrcaBillingStatus } from '../use-orca-billing-status'
import { TeamPageView } from './TeamPageView'
import { createTeamFailureCopy, mutationFailureCopy } from './team-copy'
import { clearTeamPageArrival, closeTeamPage, useTeamPageState } from './team-page-store'
import { useOrgRoster } from './use-org-roster'
import { useTeamActions } from './use-team-actions'

function TeamPageBody({ arrival }: { arrival: ReturnType<typeof useTeamPageState>['arrival'] }) {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const selectOrg = useAppStore((state) => state.selectOrcaProfileOrg)
  const refreshAuth = useAppStore((state) => state.refreshCurrentOrcaProfileAuth)
  const openModal = useAppStore((state) => state.openModal)
  const cloud = authStatus?.cloud
  const orgId = cloud?.activeOrgId ?? null
  const roster = useOrgRoster(orgId)
  const billing = useOrcaBillingStatus(true)
  const [userRefreshing, setUserRefreshing] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createUnavailable, setCreateUnavailable] = useState(false)
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null)
  const [now] = useState(() => Date.now())

  const quietRefresh = useCallback(() => {
    roster.refresh()
    billing.refresh()
  }, [roster, billing])
  const actions = useTeamActions({ orgId: orgId ?? '', onChanged: quietRefresh })

  const rosterResult =
    roster.result?.status === 'ok'
      ? { ...roster.result, roster: actions.applyOverlays(roster.result.roster, roster.resultSeq) }
      : roster.result

  const openPortal = (): void => {
    setBillingBusy(true)
    void window.api.orcaProfiles
      .billingOpenPortal()
      .catch((error: unknown): OrcaBillingOpenResult => ({
        status: 'failed',
        error: String(error)
      }))
      .then((outcome) => {
        setBillingBusy(false)
        const failure = openFailureCopy(outcome, t)
        if (failure) {
          toast.error(failure)
        }
      })
  }

  const createTeam = (name: string): void => {
    setCreating(true)
    setCreateError(null)
    void window.api.orcaProfiles
      .orgCreate({ name })
      .catch((error: unknown): OrcaProfileOrgCreateResult => ({
        status: 'failed',
        error: String(error)
      }))
      .then(async (outcome) => {
        if (outcome.status === 'created') {
          await selectOrg(outcome.orgId)
          clearTeamPageArrival()
          toast.success(
            t('auto.components.billing.team.createdToast', '{{value0}} created', {
              value0: outcome.name
            })
          )
        } else if (outcome.status === 'unsupported') {
          setCreateUnavailable(true)
        } else {
          setCreateError(createTeamFailureCopy(outcome, t))
        }
        setCreating(false)
      })
  }

  const switchOrg = (target: string): void => {
    setSwitchingOrgId(target)
    void selectOrg(target).finally(() => setSwitchingOrgId(null))
  }

  const leave = (): void => {
    if (!orgId) {
      return
    }
    const name = cloud?.activeOrgName ?? t('auto.components.billing.team.thisTeam', 'this team')
    void confirm({
      title: t('auto.components.billing.team.leaveConfirmTitle', 'Leave {{value0}}?', {
        value0: name
      }),
      description: t(
        'auto.components.billing.team.leaveConfirmBody',
        'You lose access to the team’s cloud workspaces and secrets right away. An owner or admin can invite you back.'
      ),
      confirmLabel: t('auto.components.billing.team.leaveCta', 'Leave team'),
      confirmVariant: 'destructive'
    }).then((accepted) => {
      if (!accepted) {
        return
      }
      void window.api.orcaProfiles
        .orgLeave({ orgId })
        .catch((error: unknown) => ({ status: 'failed' as const, error: String(error) }))
        .then(async (outcome) => {
          if (outcome.status === 'ok') {
            await refreshAuth()
            closeTeamPage()
            toast.success(
              t('auto.components.billing.team.leftToast', 'You left {{value0}}', { value0: name })
            )
          } else {
            toast.error(mutationFailureCopy(outcome, t) ?? '')
          }
        })
    })
  }

  const org =
    orgId && arrival?.kind !== 'create' ? { orgId, name: cloud?.activeOrgName ?? orgId } : null

  return (
    <TeamPageView
      org={org}
      viewerUserId={cloud?.userId ?? null}
      roster={rosterResult}
      billing={billing.result}
      arrival={arrival}
      rowStates={actions.rowStates}
      refreshing={userRefreshing && (roster.loading || billing.loading)}
      billingBusy={billingBusy}
      now={now}
      create={{
        organizations: (authStatus?.organizations ?? []).filter(
          (candidate) => candidate.orgId !== orgId
        ),
        creating,
        error: createError,
        unavailable: createUnavailable,
        switchingOrgId
      }}
      onCreateTeam={createTeam}
      onSwitchOrg={switchOrg}
      onRefresh={() => {
        setUserRefreshing(true)
        quietRefresh()
        window.setTimeout(() => setUserRefreshing(false), 600)
      }}
      onInvite={actions.invite}
      onChangeRole={(member, role) => actions.changeRole(member, role)}
      onMakeOwner={actions.makeOwner}
      onRemove={actions.remove}
      onResend={actions.resend}
      onRevoke={(email) => {
        const role =
          rosterResult?.status === 'ok'
            ? (rosterResult.roster.pendingInvites.find((invite) => invite.email === email)?.role ??
              'member')
            : 'member'
        actions.revoke(email, role)
      }}
      onLeave={leave}
      onSeePlans={() => {
        closeTeamPage()
        openPlansPage('team')
      }}
      onManageBilling={openPortal}
      onCreateWorkspace={() => {
        closeTeamPage()
        openModal('new-workspace-composer', { telemetrySource: 'unknown' })
      }}
      onDismissArrival={clearTeamPageArrival}
      onContactSales={(url) => void window.api.shell.openUrl(url)}
    />
  )
}

/** The Team page's dialog surface: top-anchored so loading and checkout arrivals never jump. */
export function TeamDialogContent({ children }: { children: React.ReactNode }): React.JSX.Element {
  const t = useTranslate()
  return (
    <DialogContent
      scrollable
      className="top-[6vh] max-h-[88vh] translate-y-0 sm:max-w-2xl"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        if (event.currentTarget instanceof HTMLElement) {
          event.currentTarget.focus()
        }
      }}
    >
      <DialogTitle className="sr-only">
        {t('auto.components.billing.team.title', 'Team')}
      </DialogTitle>
      <DialogDescription className="sr-only">
        {t(
          'auto.components.billing.team.description',
          'Members, invites, roles, seats and your Orca Cloud plan.'
        )}
      </DialogDescription>
      {children}
    </DialogContent>
  )
}

/**
 * The Team page: members, invites, roles, seats and the plan, in one place. A dialog like the
 * plans page so it opens over whatever the user was doing; Checkout lands here when it succeeds.
 */
export function TeamDialogHost(): React.JSX.Element {
  const { open, arrival } = useTeamPageState()
  // Remount per team so optimistic rows and row errors never carry over to another org.
  const orgKey = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.activeOrgId ?? 'none')
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeTeamPage()
        }
      }}
    >
      {open ? (
        <TeamDialogContent>
          <TeamPageBody key={orgKey} arrival={arrival} />
        </TeamDialogContent>
      ) : null}
    </Dialog>
  )
}
