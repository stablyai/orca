import { useCallback, useRef } from 'react'
import { toast } from 'sonner'

import { bindTaskPageOdooItemSourceContext } from '@/components/task-page-odoo-item-source-context'
import { getOdooTicketWorkspaceSeed } from '@/components/odoo-ticket-workspace-seed'
import { selectOdooAutoWorkspaceCandidates } from '@/components/odoo-auto-workspace-criteria'
import { readOdooAutoWorkspaceSettings } from '@/components/odoo-auto-workspace-settings'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { OdooTicket } from '../../../shared/odoo-types'
import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'
/**
 * Starts a workspace for freshly loaded tickets that match the configured
 * criteria, without asking.
 *
 * Runs off the panel's own reads (manual refresh and the slow timer) rather
 * than a scheduler of its own, so it can never fire more often than the panel
 * already talks to Odoo.
 */
export function useOdooAutoWorkspace(): (tickets: readonly OdooTicket[]) => void {
  // Tickets handled this session. Guards the window between "create started"
  // and "worktree appears in the store", where the ticket still looks unlinked.
  const handledRef = useRef<Set<number>>(new Set())
  const runningRef = useRef(false)

  return useCallback((tickets: readonly OdooTicket[]) => {
    const settings = readOdooAutoWorkspaceSettings()
    if (!settings.enabled || !settings.repoId || runningRef.current) {
      return
    }
    const state = useAppStore.getState()
    const excluded = new Set(handledRef.current)
    for (const worktree of state.allWorktrees()) {
      if (worktree.linkedOdooTicket) {
        excluded.add(worktree.linkedOdooTicket)
      }
    }
    const { selected, droppedByCap } = selectOdooAutoWorkspaceCandidates(
      tickets,
      settings.criteria,
      {
        viewerUid: state.odooStatus.viewer?.uid,
        now: Date.now(),
        excludedTicketIds: excluded,
        maxPerRun: settings.maxPerRun
      }
    )
    if (selected.length === 0) {
      return
    }
    if (droppedByCap > 0) {
      // Never drop silently: a run that quietly ignored matches would read as
      // "the criteria are wrong" rather than "the cap held".
      toast.warning(
        droppedByCap === 1
          ? translate(
              'auto.components.odoo.auto.workspace.capped_one',
              '{{count}} more matching ticket was skipped by the per-run limit.',
              { count: droppedByCap }
            )
          : translate(
              'auto.components.odoo.auto.workspace.capped_other',
              '{{count}} more matching tickets were skipped by the per-run limit.',
              { count: droppedByCap }
            )
      )
    }

    const repoId = settings.repoId
    const baseBranch = settings.baseBranch
    runningRef.current = true
    void (async () => {
      try {
        for (const ticket of selected) {
          const taskSourceContext = bindTaskPageOdooItemSourceContext({
            ticket,
            instances: state.odooStatus.instances ?? [],
            settings: state.settings ?? { activeRuntimeEnvironmentId: null }
          })
          if (!taskSourceContext) {
            continue
          }
          handledRef.current.add(ticket.id)
          const resolvedInstanceId =
            taskSourceContext.providerIdentity?.provider === 'odoo'
              ? (taskSourceContext.providerIdentity.instanceId ?? undefined)
              : undefined
          const linkedWorkItem: WorkspaceLinkedItem = {
            provider: 'odoo',
            type: 'issue',
            number: ticket.id,
            title: `${ticket.ref} ${ticket.title}`,
            url: ticket.url,
            odooInstanceId: resolvedInstanceId
          }
          try {
            await useAppStore
              .getState()
              .createWorktree(
                repoId,
                getOdooTicketWorkspaceSeed(ticket),
                baseBranch,
                'inherit',
                undefined,
                'sidebar',
                `${ticket.ref} ${ticket.title}`,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { linkedWorkItem, linkedTaskSourceContext: taskSourceContext }
              )
            toast.success(
              translate(
                'auto.components.odoo.auto.workspace.created',
                'Started a workspace for {{value0}}.',
                { value0: ticket.ref }
              )
            )
          } catch (error) {
            // Keep the ticket in handled: retrying every refresh would hammer
            // a repo that is failing for a structural reason.
            toast.error(
              translate(
                'auto.components.odoo.auto.workspace.failed',
                'Could not start a workspace for {{value0}}.',
                { value0: ticket.ref }
              ),
              { description: error instanceof Error ? error.message : undefined }
            )
          }
        }
      } finally {
        runningRef.current = false
      }
    })()
  }, [])
}
