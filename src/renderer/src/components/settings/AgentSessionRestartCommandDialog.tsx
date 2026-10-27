import { useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { AgentSessionRestartTarget } from '@/lib/agent-session-restart-plan'
import { restartAgentWithConfirmedCommand } from '@/lib/agent-session-restart-command'

export function AgentSessionRestartCommandDialog({
  target,
  onClose
}: {
  target: AgentSessionRestartTarget
  onClose: () => void
}): React.JSX.Element {
  const submitting = useRef(false)
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)
  const sessionId = target.pane.providerSession?.id
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'settings.manageSessions.commandTitle',
              'Restart {{agent}} in this terminal',
              { agent: target.label }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'settings.manageSessions.commandRestartDescription',
              'Exit the current process and run your command in the same pane. Include the original flags and any account settings. This command is not modified automatically.'
            )}
          </DialogDescription>
        </DialogHeader>
        {sessionId ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.manageSessions.commandResumeHint',
              'To keep this conversation, include your CLI’s resume option with'
            )}{' '}
            <code className="break-all">{sessionId}</code>.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.manageSessions.commandNoSessionHint',
              'No conversation ID was recorded. Use an explicit resume command to restore a chat; a normal launch command starts a new chat.'
            )}
          </p>
        )}
        <label className="space-y-2 text-sm">
          {translate('settings.manageSessions.commandLabel', 'Launch command')}
          <Input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={running || started}
            variant="code"
            placeholder={translate(
              'settings.manageSessions.commandPlaceholder',
              'Paste the full CLI command'
            )}
          />
        </label>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {started ? (
          <p role="status" className="text-xs">
            {translate(
              'settings.manageSessions.commandStarted',
              'Command launched in the existing pane. Check the terminal for conversation restoration.'
            )}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {started || running
              ? translate('settings.manageSessions.commandClose', 'Close')
              : translate('settings.manageSessions.commandCancel', 'Cancel')}
          </Button>
          {!started ? (
            <Button
              size="sm"
              disabled={running || !command.trim()}
              onClick={() => {
                if (submitting.current) {
                  return
                }
                submitting.current = true
                setRunning(true)
                setError(null)
                void restartAgentWithConfirmedCommand(target.pane, command)
                  .then(() => setStarted(true))
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : 'Restart failed.')
                  )
                  .finally(() => {
                    submitting.current = false
                    setRunning(false)
                  })
              }}
            >
              {running
                ? translate('settings.manageSessions.commandRunning', 'Restarting…')
                : translate('settings.manageSessions.commandRun', 'Exit and run command')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
