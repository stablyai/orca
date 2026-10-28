import { Button } from '@/components/ui/button'
import type { WslHostWindowsDriveRefusal } from '../../../../shared/wsl-host-windows-drive-refusal'
import {
  addOnThisComputerLabel,
  wslHostWindowsDriveRefusalCopy
} from '@/lib/wsl-host-windows-drive-refusal-toast'

/** Inline, not a toast: the user must act, and toasts above the dialog take no clicks. */
export function AddRepoWindowsDriveNotice({
  refusal,
  onAddOnThisComputer
}: {
  refusal: WslHostWindowsDriveRefusal
  onAddOnThisComputer: ((windowsPath: string) => void) | null
}): React.JSX.Element {
  const { title, description } = wslHostWindowsDriveRefusalCopy(refusal)
  const { windowsPath } = refusal
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
    >
      <p className="text-xs font-medium text-destructive">{title}</p>
      <p className="text-[11px] text-muted-foreground">{description}</p>
      {/* A wrong prefill is worse than none: offer the switch only when the drive path is known. */}
      {windowsPath && onAddOnThisComputer ? (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => onAddOnThisComputer(windowsPath)}
        >
          {addOnThisComputerLabel()}
        </Button>
      ) : null}
    </div>
  )
}
