import { ArchiveRestore, LoaderCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function SessionLoadingState(): React.JSX.Element {
  return (
    <div className="px-3 py-3" aria-busy="true">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        <span>
          {translate(
            'auto.components.right.sidebar.AiVaultPanelControls.scanningSessions',
            'Scanning sessions'
          )}
        </span>
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="mt-1 size-4 rounded-full bg-sidebar-accent" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3 w-4/5 rounded-sm bg-sidebar-accent" />
              <div className="h-2.5 w-3/5 rounded-sm bg-sidebar-accent/75" />
              <div className="h-2.5 w-2/5 rounded-sm bg-sidebar-accent/60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function EmptyState({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center text-muted-foreground">
      <ArchiveRestore className="mb-3 size-7 opacity-50" />
      <p className="text-sm font-medium">{title}</p>
    </div>
  )
}
