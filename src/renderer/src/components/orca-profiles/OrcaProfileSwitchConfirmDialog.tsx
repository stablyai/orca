import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { OrcaProfileSummary } from '../../../../shared/orca-profiles'
import type { OrcaProfileSwitchLiveWorkSummary } from './orca-profile-switch-liveness'

function liveWorkLines(summary: OrcaProfileSwitchLiveWorkSummary): string[] {
  const lines: string[] = []
  if (summary.liveTerminalTabCount > 0) {
    lines.push(
      translate(
        summary.liveTerminalTabCount === 1
          ? 'auto.components.orca.profiles.switch.confirm.terminalSingular'
          : 'auto.components.orca.profiles.switch.confirm.terminalPlural',
        summary.liveTerminalTabCount === 1
          ? '{{count}} live terminal tab'
          : '{{count}} live terminal tabs',
        { count: summary.liveTerminalTabCount }
      )
    )
  }
  if (summary.liveAgentCount > 0) {
    lines.push(
      translate(
        summary.liveAgentCount === 1
          ? 'auto.components.orca.profiles.switch.confirm.agentSingular'
          : 'auto.components.orca.profiles.switch.confirm.agentPlural',
        summary.liveAgentCount === 1 ? '{{count}} active agent' : '{{count}} active agents',
        { count: summary.liveAgentCount }
      )
    )
  }
  if (summary.browserWorkspaceCount > 0) {
    lines.push(
      translate(
        summary.browserWorkspaceCount === 1
          ? 'auto.components.orca.profiles.switch.confirm.browserSingular'
          : 'auto.components.orca.profiles.switch.confirm.browserPlural',
        summary.browserWorkspaceCount === 1
          ? '{{count}} browser workspace'
          : '{{count}} browser workspaces',
        { count: summary.browserWorkspaceCount }
      )
    )
  }
  return lines
}

export function OrcaProfileSwitchConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  activeProfileName,
  targetProfile,
  liveWorkSummary,
  switching
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  activeProfileName: string
  targetProfile: OrcaProfileSummary | null
  liveWorkSummary: OrcaProfileSwitchLiveWorkSummary
  switching: boolean
}): React.JSX.Element {
  const targetName =
    targetProfile?.name ??
    translate('auto.components.orca.profiles.switch.confirm.target', 'the selected profile')
  const lines = liveWorkLines(liveWorkSummary)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            {translate('auto.components.orca.profiles.switch.confirm.title', 'Switch profiles?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.orca.profiles.switch.confirm.description',
              'Switching to {{targetName}} will relaunch Orca and reload the workspace for {{activeProfileName}}.',
              { activeProfileName, targetName }
            )}
          </DialogDescription>
        </DialogHeader>

        {lines.length > 0 ? (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <div className="mb-1 font-medium text-foreground">
              {translate(
                'auto.components.orca.profiles.switch.confirm.live.work',
                'Live work in this profile'
              )}
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={switching}
          >
            {translate('auto.components.orca.profiles.switch.confirm.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={switching}>
            {switching ? <Loader2 className="size-4 animate-spin" /> : null}
            {translate('auto.components.orca.profiles.switch.confirm.switch', 'Switch profile')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
