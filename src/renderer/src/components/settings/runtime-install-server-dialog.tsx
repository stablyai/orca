import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { managedServerOutcomeLabel } from './managed-server-copy'
import { SshTargetSelect } from './SshTargetSelect'

type RuntimeInstallServerDialogProps = {
  open: boolean
  api: ManagedOrcadPreloadApi
  emptyTargets: SshTarget[]
  loadFailed: boolean
  onOpenChange: (open: boolean) => void
  onDeployed: () => Promise<void> | void
}

/** Install a managed Orca server on an SSH host that doesn't run one yet. */
export function RuntimeInstallServerDialog({
  open,
  api,
  emptyTargets,
  loadFailed,
  onOpenChange,
  onDeployed
}: RuntimeInstallServerDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState('')
  const [deploying, setDeploying] = useState(false)
  const openRef = useRef(open)
  // Why: bumps on every open, so a background install only resets the session it started in.
  const sessionRef = useRef(0)
  useEffect(() => {
    openRef.current = open
    if (open) {
      sessionRef.current += 1
    }
  }, [open])
  const hostFieldId = useId()
  const nameFieldId = useId()
  const targetLabel = emptyTargets.find((target) => target.id === targetId)?.label ?? ''
  const serverName = name.trim() || targetLabel
  const canSubmit = !deploying && targetId !== '' && serverName !== ''

  const deploy = async (): Promise<void> => {
    const session = sessionRef.current
    setDeploying(true)
    try {
      const result = await api.deploy({ name: serverName, sshTargetId: targetId })
      if (result.outcome === 'deferred') {
        toast.message(managedServerOutcomeLabel(result))
      } else {
        toast.success(
          translate(
            'auto.components.settings.serverList.setUpDone',
            'Orca is set up on {{name}}.',
            {
              name: result.environment.name
            }
          )
        )
        // Why: leave a form the user reopened since this install started alone.
        const sameSession = session === sessionRef.current
        if (mountedRef.current && (!openRef.current || sameSession)) {
          setName('')
          setTargetId('')
          if (openRef.current) {
            onOpenChange(false)
          }
        }
      }
      await onDeployed()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setDeploying(false)
      }
    }
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next && deploying) {
      toast.message(
        translate(
          'auto.components.settings.serverList.settingUpInBackground',
          'Setting up Orca on {{name}} in the background. It appears in the list when it’s ready.',
          { name: serverName }
        )
      )
    }
    onOpenChange(next)
  }

  return (
    // Why closable mid-deploy: an SSH install can take minutes; it finishes in the background.
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) {
              void deploy()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.settings.serverList.setUpOnSshHost',
                'Set up Orca on an SSH host'
              )}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {translate(
                    'auto.components.settings.managedServers.description',
                    'Orca installs itself on an empty SSH host and keeps itself up to date.'
                  )}
                </p>
                {/* Why: this is the moment something moves, so say what does and doesn't. */}
                <p>
                  {translate(
                    'auto.components.settings.managedServers.reassurance',
                    'Runs on each host, reached over your own SSH connection. Your code and files stay where they are. Only Orca’s list of projects, tabs and terminals moves to the host.'
                  )}
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={hostFieldId}>
              {translate('auto.components.settings.managedServers.deploy.host', 'SSH host')}
            </Label>
            <SshTargetSelect
              id={hostFieldId}
              targets={emptyTargets}
              value={targetId}
              onChange={setTargetId}
              placeholder={translate(
                'auto.components.settings.serverList.installHostPlaceholder',
                'Choose an SSH host without Orca'
              )}
            />
            <p className="text-xs text-muted-foreground">
              {emptyTargets.length === 0
                ? translate(
                    'auto.components.settings.serverList.installNoHosts',
                    'No SSH hosts without an Orca server.'
                  )
                : translate(
                    'auto.components.settings.serverList.installHostHelp',
                    'Only hosts without an Orca server.'
                  )}{' '}
              <button
                type="button"
                className="cursor-pointer text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onOpenChange(false)
                  openSettingsTarget({ pane: 'ssh', repoId: null })
                }}
              >
                {translate('auto.components.settings.serverList.addSshHost', 'Add an SSH host')}
              </button>
            </p>
            {loadFailed ? (
              <p className="text-xs text-destructive">
                {translate(
                  'auto.components.settings.managedServers.loadFailed',
                  'Orca couldn’t load SSH hosts and unfinished moves. Reopen Settings to try again.'
                )}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={nameFieldId}>
              {translate('auto.components.settings.managedServers.deploy.name', 'Server name')}{' '}
              <span className="font-normal text-muted-foreground">
                {translate('auto.components.settings.RuntimeHostAccessForm.optional', '(optional)')}
              </span>
            </Label>
            <Input
              id={nameFieldId}
              value={name}
              placeholder={
                targetLabel ||
                translate(
                  'auto.components.settings.serverList.installNamePlaceholder',
                  'Same as the SSH host'
                )
              }
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
              {deploying
                ? translate('auto.components.settings.serverList.close', 'Close')
                : translate('auto.components.settings.serverList.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {deploying ? <LoadingSpinner className="size-3.5" /> : null}
              {deploying
                ? translate(
                    'auto.components.settings.sshHostServer.deploying',
                    'Setting up Orca on {{host}}…',
                    {
                      host: targetLabel
                    }
                  )
                : translate('auto.components.settings.serverList.setUp', 'Set up')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
