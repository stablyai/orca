import { useEffect, useRef, useState } from 'react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../ui/dialog'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getTerminalWindowsAdministratorSearchEntry } from './terminal-windows-search'
import { MANAGE_SESSIONS_SECTION_ID } from './TerminalTccAttributionNotice'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'

export function TerminalWindowsAdministratorSection(): React.JSX.Element {
  const [administrator, setAdministrator] = useState<boolean | null | undefined>()
  const [restartAvailable, setRestartAvailable] = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [manualInstructions, setManualInstructions] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((state) => state.setSettingsSearchQuery)
  useEffect(() => {
    let active = true
    void Promise.all([
      window.api.app.getWindowsAdministratorStatus().catch(() => null),
      window.api.app.getIdentity().catch(() => null)
    ]).then(([status, identity]) => {
      if (active) {
        setAdministrator(status)
        setRestartAvailable(identity !== null && !identity.isDev && !isWebClientLocation())
      }
    })
    return () => {
      active = false
    }
  }, [])

  const status =
    administrator === undefined
      ? translate('settings.terminal.windows.checkingAdministrator', 'Checking…')
      : administrator === null
        ? translate('settings.terminal.windows.unknownAdministrator', 'Unable to determine')
        : administrator
          ? translate('settings.terminal.windows.administratorStatus', 'Administrator')
          : translate('settings.terminal.windows.standardStatus', 'Standard user')

  const helpLabel = administrator
    ? translate('settings.terminal.windows.returnStandardHelp', 'Standard mode guide')
    : translate('settings.terminal.windows.runAdministratorHelp', 'Administrator guide')
  const restartLabel = translate(
    'settings.terminal.windows.restartAdministrator',
    'Restart as administrator'
  )
  const canRestart = restartAvailable && administrator !== true
  const showConfirmation = canRestart && !manualInstructions

  const changeDialogOpen = (open: boolean): void => {
    if (restarting) {
      return
    }
    if (open) {
      setManualInstructions(false)
      setRestartError(false)
    }
    setInstructionsOpen(open)
  }

  const restartAsAdministrator = async (): Promise<void> => {
    if (restarting) {
      return
    }
    setRestarting(true)
    setRestartError(false)
    try {
      await window.api.app.restartAsAdministrator()
    } catch {
      setRestarting(false)
      setRestartError(true)
    }
  }

  const openManageSessions = (): void => {
    setInstructionsOpen(false)
    setSettingsSearchQuery('')
    openSettingsTarget({
      pane: 'terminal',
      repoId: null,
      sectionId: MANAGE_SESSIONS_SECTION_ID
    })
  }

  return (
    <SearchableSetting {...getTerminalWindowsAdministratorSearchEntry()[0]} className="@container">
      <Dialog open={instructionsOpen} onOpenChange={changeDialogOpen}>
        <SettingsRow
          className="flex-col items-start @lg:flex-row @lg:items-center"
          label={
            <span className="flex flex-wrap items-center gap-2">
              {translate('settings.terminal.windows.administratorLabel', 'Administrator mode')}
              <Badge variant="outline" role="status">
                {status}
              </Badge>
            </span>
          }
          description={translate(
            'settings.terminal.windows.administratorScope',
            'Permissions for the Orca app. Existing terminals may differ.'
          )}
          control={
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={administrator === undefined}>
                {canRestart ? restartLabel : helpLabel}
              </Button>
            </DialogTrigger>
          }
        />
        <DialogContent
          showCloseButton={!restarting}
          onOpenAutoFocus={(event) => {
            if (showConfirmation) {
              event.preventDefault()
              cancelRef.current?.focus()
            }
          }}
          onPointerDownOutside={(event) => {
            if (restarting) {
              event.preventDefault()
            }
          }}
          onEscapeKeyDown={(event) => {
            if (restarting) {
              event.preventDefault()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {showConfirmation
                ? translate(
                    'settings.terminal.windows.confirmAdministratorRestart',
                    'Restart as administrator?'
                  )
                : helpLabel}
            </DialogTitle>
            <DialogDescription>
              {showConfirmation
                ? translate(
                    'settings.terminal.windows.administratorApproval',
                    'Windows will ask for approval. Use your usual account.'
                  )
                : translate(
                    'settings.terminal.windows.administratorDialogScope',
                    'This changes permissions for the whole app. SSH and WSL keep their own permissions.'
                  )}
            </DialogDescription>
          </DialogHeader>
          {showConfirmation ? (
            <div className="space-y-3">
              <p className="text-sm">
                {translate(
                  'settings.terminal.windows.administratorRestartConsequences',
                  'Save your work first. After approval, terminals and agents on the current local terminal host close. Restored tabs open new administrator shells.'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'settings.terminal.windows.administratorPromptCancellation',
                  'Canceling Windows’ prompt reopens Orca with its retained terminals. SSH and WSL permissions stay controlled on their hosts.'
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <ol className="list-decimal space-y-3 pl-5 text-sm">
                <li>
                  {translate(
                    'settings.terminal.windows.closeLocalSessions',
                    'Save your work, close all local terminal sessions, then exit Orca.'
                  )}
                </li>
                <li>
                  {administrator
                    ? translate(
                        'settings.terminal.windows.launchStandard',
                        'Open Orca normally from the Windows Start menu.'
                      )
                    : translate(
                        'settings.terminal.windows.launchAdministrator',
                        'In the Windows Start menu, right-click Orca and choose Run as administrator. Approve the Windows prompt using your usual account.'
                      )}
                </li>
              </ol>
              <p className="text-sm">
                {translate(
                  'settings.terminal.windows.retainedTerminalPermissions',
                  'If new terminals still use the previous permissions, open Manage Sessions and choose Restart daemon. This closes local terminals and their running commands.'
                )}
              </p>
            </div>
          )}
          {restartError && (
            <p role="alert" className="text-sm text-destructive">
              {translate(
                'settings.terminal.windows.administratorRestartFailed',
                'Orca could not restart. Try again or use the manual instructions.'
              )}
            </p>
          )}
          <DialogFooter>
            {showConfirmation ? (
              <Button
                variant="link"
                size="sm"
                disabled={restarting}
                onClick={() => {
                  setManualInstructions(true)
                  setRestartError(false)
                }}
              >
                {translate(
                  'settings.terminal.windows.manualAdministratorHelp',
                  'Manual instructions'
                )}
              </Button>
            ) : (
              <Button
                variant="link"
                size="sm"
                onClick={() =>
                  void window.api.shell.openUrl(
                    'https://www.onorca.dev/docs/terminal#windows-administrator-mode'
                  )
                }
              >
                {translate(
                  'settings.terminal.windows.administratorDocumentation',
                  'Read the guide'
                )}
              </Button>
            )}
            <DialogClose asChild>
              <Button variant="ghost" size="sm" ref={cancelRef} disabled={restarting}>
                {showConfirmation
                  ? translate('settings.terminal.windows.cancelAdministratorRestart', 'Cancel')
                  : translate('settings.terminal.windows.closeAdministratorHelp', 'Close')}
              </Button>
            </DialogClose>
            {showConfirmation ? (
              <Button size="sm" disabled={restarting} onClick={() => void restartAsAdministrator()}>
                {restarting
                  ? translate('settings.terminal.windows.restartingAdministrator', 'Restarting…')
                  : restartLabel}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={openManageSessions}>
                {translate('settings.terminal.windows.openManageSessions', 'Open Manage Sessions')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SearchableSetting>
  )
}
