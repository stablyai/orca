// Remove… for a saved Orca-account credential: the confirm row (active and expired rows) and the
// expired row's ⋯ menu that opens it (RA-5).
import type React from 'react'
import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentsErrorCode
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { RowShell } from './orca-cloud-account-row-shell'
import { agentName, productName } from './orca-cloud-accounts-copy'
import type { OrcaCloudAccountsActions } from './orca-cloud-accounts-types'

export function RemoveConfirmRow({
  agent,
  actions,
  setConfirmRemove,
  setRowError
}: {
  agent: OrcaCloudAccountAgent
  actions: OrcaCloudAccountsActions
  setConfirmRemove: (open: boolean) => void
  setRowError: (error: OrcaCloudAgentsErrorCode | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const product = productName(agent, t)
  const remove = async (): Promise<void> => {
    setBusy(true)
    const error = await actions.remove(agent)
    setBusy(false)
    setRowError(error)
    if (!error) {
      setConfirmRemove(false)
    }
  }
  return (
    <RowShell
      agent={agent}
      tone="warning"
      title={t(
        'orcaCloudAccounts.removeConfirm',
        'Remove your {{product}} account from Orca? Cloud workspaces use the team key, or ask you to sign in.',
        { product }
      )}
      actions={
        <>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            aria-busy={busy || undefined}
            autoFocus
            onClick={() => void remove()}
          >
            {t('orcaCloudAccounts.remove', 'Remove')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmRemove(false)}
          >
            {t('orcaCloudAccounts.cancel', 'Cancel')}
          </Button>
        </>
      }
    />
  )
}

export function RowRemoveMenu({
  agent,
  onRemove
}: {
  agent: OrcaCloudAccountAgent
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('orcaCloudAccounts.rowMenu', '{{agent}} account options', {
            agent: agentName(agent, t)
          })}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onRemove}>
          {t('orcaCloudAccounts.removeEllipsis', 'Remove…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
