import { Info } from 'lucide-react'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { translate } from '@/i18n/i18n'

// Why: agent authoring (create/edit/delete/enable/default/env) is a desktop-host
// concern. Paired web clients render the synced catalog view-only and never issue
// authoring writes; the host also rejects remote authoring at the RPC boundary
// (defense-in-depth). These helpers gate the client surface.

/** Whether the Agents settings pane is read-only. Explicit prop wins (tests, future
 *  callers); otherwise a paired web client window is read-only. */
export function resolveAgentsPaneReadOnly(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') {
    return explicit
  }
  return isPairedWebClientWindow()
}

/** Run an authoring write only when the pane is editable. A read-only client never
 *  mutates catalog/settings state (the disabled fieldset also blocks interaction). */
export function guardAgentsPaneWrite(isReadOnly: boolean, write: () => void): void {
  if (isReadOnly) {
    return
  }
  write()
}

export function AgentsPaneReadOnlyNotice(): React.JSX.Element {
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-sm"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-0.5">
        <p className="font-medium text-foreground">
          {translate(
            'auto.components.settings.AgentsPane.agentsReadOnlyTitle',
            'Agent settings are managed on the desktop'
          )}
        </p>
        <p className="text-muted-foreground">
          {translate(
            'auto.components.settings.AgentsPane.agentsReadOnlyDescription',
            'This is a paired client. To add, edit, or remove agents and change defaults, use the Orca desktop app.'
          )}
        </p>
      </div>
    </div>
  )
}
