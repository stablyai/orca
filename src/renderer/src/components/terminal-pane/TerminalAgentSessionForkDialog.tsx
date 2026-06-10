import { Copy, GitFork } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  copyAgentSessionForkContext,
  startAgentSessionFork,
  type PreparedAgentSessionFork
} from './terminal-agent-session-fork'
import { translate } from '@/i18n/i18n'

type TerminalAgentSessionForkDialogProps = {
  open: boolean
  fork: PreparedAgentSessionFork | null
  onOpenChange: (open: boolean) => void
}

export function TerminalAgentSessionForkDialog({
  open,
  fork,
  onOpenChange
}: TerminalAgentSessionForkDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const handleCopyContext = async (): Promise<void> => {
    if (!fork || busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      if (await copyAgentSessionForkContext(fork)) {
        onOpenChange(false)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleStartFork = async (): Promise<void> => {
    if (!fork || busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      if (await startAgentSessionFork(fork)) {
        onOpenChange(false)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (busyRef.current && !nextOpen) {
      return
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-4 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base">{translate("auto.components.terminal.pane.TerminalAgentSessionForkDialog.64e292e8e3", "Fork Agent Session")}</DialogTitle>
          <DialogDescription>
            {translate("auto.components.terminal.pane.TerminalAgentSessionForkDialog.619b5a35d2", "Create a top-level workspace fork and start a fresh agent tab with captured context.")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
          <GitFork className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{translate("auto.components.terminal.pane.TerminalAgentSessionForkDialog.620461df22", "Top-level fork")}</p>
            <p className="text-xs text-muted-foreground">
              {translate("auto.components.terminal.pane.TerminalAgentSessionForkDialog.0c8a8629b1", "The fork appears as its own workspace, not as a nested child. The new agent receives a bounded transcript as an editable draft.")}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void handleCopyContext()}>
            <Copy className="size-4" />
            {translate("auto.components.terminal.pane.TerminalAgentSessionForkDialog.17fc841e59", "Copy context")}</Button>
          <Button disabled={busy} onClick={() => void handleStartFork()}>
            <GitFork className="size-4" />
            {busy ? translate("auto.components.terminal.pane.TerminalAgentSessionForkDialog.2b10412cfc", "Creating...") : translate("auto.components.terminal.pane.TerminalAgentSessionForkDialog.9d25de2920", "Create fork")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
