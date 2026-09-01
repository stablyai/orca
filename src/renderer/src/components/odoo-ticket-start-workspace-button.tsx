import { ArrowRight, ChevronDown, FolderKanban, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { bindTaskPageOdooItemSourceContext } from '@/components/task-page-odoo-item-source-context'
import { getOdooTicketWorkspaceSeed } from '@/components/odoo-ticket-workspace-seed'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  findOdooTicketWorkspaceAttachment,
  getOdooTicketWorkspaceAttachmentLabel
} from '@/lib/odoo-ticket-workspace-attachment'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAllWorktrees } from '@/store/selectors'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { OdooTicket } from '../../../shared/odoo-types'
import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'
/** Reproduces the "Start workspace" control from GitHubItemDialog's
 *  GHEditSection for an Odoo ticket: a plain start button, or — once a
 *  workspace is attached — an Open/Start-new split button. */
export function OdooTicketStartWorkspaceButton({
  ticket
}: {
  ticket: OdooTicket
}): React.JSX.Element {
  const instances = useAppStore((s) => s.odooStatus.instances)
  const settings = useAppStore((s) => s.settings)
  const openModal = useAppStore((s) => s.openModal)
  const allWorktrees = useAllWorktrees()

  const attachedWorktree = findOdooTicketWorkspaceAttachment(
    allWorktrees,
    ticket.id,
    ticket.instanceId ?? null
  )
  const attachedWorkspaceLabel = attachedWorktree
    ? getOdooTicketWorkspaceAttachmentLabel(attachedWorktree)
    : null
  const hasAttachedWorkspace = attachedWorkspaceLabel !== null

  const startWorkspace = (): void => {
    const taskSourceContext = bindTaskPageOdooItemSourceContext({
      ticket,
      instances: instances ?? [],
      settings: settings ?? { activeRuntimeEnvironmentId: null }
    })
    if (!taskSourceContext) {
      // Why: composer drops Odoo tickets without matching source context — refuse rather than create unlinked.
      toast.error(
        translate(
          'auto.components.odoo.ticket.start.workspace.button.a0cf1fc429',
          'Couldn’t link this ticket. Reconnect Odoo or pick the matching instance, then try again.'
        )
      )
      return
    }
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
    openModal('new-workspace-composer', {
      linkedWorkItem,
      taskSourceContext,
      prefilledName: getOdooTicketWorkspaceSeed(ticket),
      telemetrySource: 'sidebar'
    })
  }

  const handleOpenOrUseWorkspace = (): void => {
    // Why: re-read fresh worktree state at click time (not the render closure) so a
    // just-created/removed attachment isn't missed, matching GitHubItemDialog.
    const currentAttached = findOdooTicketWorkspaceAttachment(
      useAppStore.getState().allWorktrees(),
      ticket.id,
      ticket.instanceId ?? null
    )
    if (!currentAttached) {
      startWorkspace()
      return
    }
    const result = activateAndRevealWorktree(currentAttached.id)
    if (result === false) {
      toast.error(
        translate(
          'auto.components.odoo.ticket.start.workspace.button.5c1ee6b176',
          'Unable to open the workspace attached to this ticket.'
        )
      )
    }
  }

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      {attachedWorkspaceLabel ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <FolderKanban className="size-3 shrink-0" />
          <span className="truncate">{attachedWorkspaceLabel}</span>
        </span>
      ) : null}
      {hasAttachedWorkspace ? (
        <DropdownMenu modal={false}>
          <ButtonGroup>
            <Button
              type="button"
              size="sm"
              onClick={handleOpenOrUseWorkspace}
              className="gap-2"
              aria-label={translate(
                'auto.components.odoo.ticket.start.workspace.button.afad57a777',
                'Open workspace attached to ticket'
              )}
            >
              {translate(
                'auto.components.odoo.ticket.start.workspace.button.1bf8ceb7d8',
                'Open workspace'
              )}
              <ArrowRight className="size-4" />
            </Button>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.odoo.ticket.start.workspace.button.ca2a408c53',
                  'More ticket workspace actions'
                )}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </ButtonGroup>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={startWorkspace}>
              <Plus className="size-4" />
              {translate(
                'auto.components.odoo.ticket.start.workspace.button.13e2780468',
                'Start new workspace'
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          type="button"
          size="sm"
          onClick={startWorkspace}
          className="gap-2"
          aria-label={translate(
            'auto.components.odoo.ticket.start.workspace.button.961543ead1',
            'Start workspace from ticket'
          )}
        >
          {translate(
            'auto.components.odoo.ticket.start.workspace.button.961543ead1',
            'Start workspace from ticket'
          )}
          <ArrowRight className="size-4" />
        </Button>
      )}
    </div>
  )
}
