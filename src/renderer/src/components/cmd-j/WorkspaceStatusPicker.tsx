import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { FooterKey } from '@/components/worktree-jump/worktree-jump-palette-primitives'
import { getWorkspaceStatusVisualMeta } from '@/components/sidebar/workspace-status/presentation/workspace-status'
import { useModalReturnFocus } from '@/hooks/useModalReturnFocus'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { selectWorkspaceStatusesForHost } from '@/store/host-workspace-status-columns'
import { useActiveWorktree } from '@/store/selectors'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'

const CLOSE_LINGER_MS = 300

export default function WorkspaceStatusPicker(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'workspace-status-picker')
  const [lingering, setLingering] = useState(visible)
  useEffect(() => {
    if (visible) {
      setLingering(true)
      return
    }
    const timer = window.setTimeout(() => setLingering(false), CLOSE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  if (!visible && !lingering) {
    return null
  }
  return <WorkspaceStatusPickerContent visible={visible} />
}

function WorkspaceStatusPickerContent({ visible }: { visible: boolean }): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const worktree = useActiveWorktree()
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const hostWorkspaceStatuses = useAppStore((s) => s.hostWorkspaceStatuses)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  // Why: a paired host offers its own columns, so its workspaces see them here too.
  const statuses = useMemo(
    () =>
      selectWorkspaceStatusesForHost(
        { workspaceStatuses, hostWorkspaceStatuses, removedRuntimeEnvironmentIds },
        worktree
      ),
    [workspaceStatuses, hostWorkspaceStatuses, removedRuntimeEnvironmentIds, worktree]
  )
  const currentStatus = worktree ? getWorkspaceStatus(worktree, statuses) : ''

  const { captureReturnFocus } = useModalReturnFocus(visible)

  // Start every open on the workspace's own status, so one arrow key reaches its neighbor.
  const [selected, setSelected] = useState(currentStatus)
  const [query, setQuery] = useState('')
  const [previousVisible, setPreviousVisible] = useState(visible)
  if (visible !== previousVisible) {
    setPreviousVisible(visible)
    if (visible) {
      setQuery('')
      setSelected(currentStatus)
    }
  }

  const handleSelect = useCallback(
    (statusId: string) => {
      closeModal()
      if (!worktree || statusId === currentStatus) {
        return
      }
      void useAppStore
        .getState()
        .updateWorktreeMeta(
          worktree.id,
          { workspaceStatus: statusId },
          { executionHostId: worktree.hostId ?? 'local' }
        )
        .then((result) => {
          if (!result.ok) {
            toast.error(result.error)
          }
        })
    },
    [closeModal, currentStatus, worktree]
  )

  return (
    <CommandDialog
      open={visible}
      onOpenChange={(open) => !open && closeModal()}
      title={translate('auto.components.cmd.j.workspaceStatusPicker.title', 'Move to Status')}
      description={translate(
        'auto.components.cmd.j.workspaceStatusPicker.description',
        'Choose a status for the current workspace.'
      )}
      contentClassName="w-[520px]"
      onOpenAutoFocus={captureReturnFocus}
      // Why: the focus hook returns focus to the tab the user came from.
      onCloseAutoFocus={(event) => event.preventDefault()}
      commandProps={{ loop: true, value: selected, onValueChange: setSelected }}
    >
      <CommandInput
        placeholder={translate(
          'auto.components.cmd.j.workspaceStatusPicker.placeholder',
          'Search statuses...'
        )}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {translate('auto.components.cmd.j.workspaceStatusPicker.empty', 'No matching statuses.')}
        </CommandEmpty>
        {statuses.map((status) => {
          const meta = getWorkspaceStatusVisualMeta(status)
          return (
            <CommandItem
              key={status.id}
              value={status.id}
              keywords={[status.label]}
              onSelect={() => handleSelect(status.id)}
            >
              <meta.icon className={cn('size-4', meta.tone)} />
              <span className="min-w-0 flex-1 truncate">{status.label}</span>
              {status.id === currentStatus ? (
                <Check className="size-3.5 text-muted-foreground" aria-hidden="true" />
              ) : null}
            </CommandItem>
          )
        })}
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          <FooterKey>
            {translate('auto.components.cmd.j.workspaceStatusPicker.enterKey', 'Enter')}
          </FooterKey>
          <span>{translate('auto.components.cmd.j.workspaceStatusPicker.select', 'Select')}</span>
          <FooterKey>
            {translate('auto.components.cmd.j.workspaceStatusPicker.escKey', 'Esc')}
          </FooterKey>
          <span>{translate('auto.components.cmd.j.workspaceStatusPicker.close', 'Close')}</span>
          <FooterKey>↑↓</FooterKey>
          <span>{translate('auto.components.cmd.j.workspaceStatusPicker.move', 'Move')}</span>
        </div>
      </div>
    </CommandDialog>
  )
}
