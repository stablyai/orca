import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { ManagedRuntimeRemoveDialog } from './ManagedRuntimeRemoveDialog'

export function ManagedRuntimeActionsMenu(props: {
  agentLabel: string
  host: RuntimeClientTarget
  /** Update or Reinstall, when the host offers one. */
  install: { label: string; onSelect: () => void } | null
  onRemove: (() => void) | null
  disabled: boolean
}): React.JSX.Element {
  const { agentLabel, install, onRemove, disabled } = props
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'components.managed-runtime.moreActions',
              'More actions for {{agent}}',
              { agent: agentLabel }
            )}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {install === null ? null : (
            <DropdownMenuItem disabled={disabled} onSelect={install.onSelect}>
              {install.label}
            </DropdownMenuItem>
          )}
          {onRemove === null ? null : (
            <DropdownMenuItem
              variant="destructive"
              disabled={disabled}
              onSelect={() => setConfirming(true)}
            >
              {translate('components.managed-runtime.remove', 'Remove downloaded runtime')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {onRemove === null ? null : (
        <ManagedRuntimeRemoveDialog
          agentLabel={agentLabel}
          host={props.host}
          open={confirming}
          onOpenChange={setConfirming}
          onRemove={onRemove}
        />
      )}
    </>
  )
}
