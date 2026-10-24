import { ArchiveRestore } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { SidebarListLoadingState } from '../SidebarListLoadingState'

export function SessionLoadingState({
  showLabel = true
}: {
  showLabel?: boolean
}): React.JSX.Element | null {
  return showLabel ? (
    <SidebarListLoadingState
      label={translate(
        'auto.components.right.sidebar.AiVaultPanelControls.scanningSessions',
        'Scanning sessions'
      )}
    />
  ) : null
}

export function EmptyState({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center text-muted-foreground">
      <ArchiveRestore className="mb-3 size-7 opacity-50" />
      <p className="text-sm font-medium">{title}</p>
    </div>
  )
}
