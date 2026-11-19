import { useEffect, useState } from 'react'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../../../ui/dialog'
import { DialogCancel, DialogError } from '../../../ui/dialog-parts'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { getTerminalWindowsAdministratorSearchEntry } from './terminal-windows-search'
import { MANAGE_SESSIONS_SECTION_ID } from '../session-management/open-terminal-manage-sessions'
import { useAppStore } from '../../../../store/index'
import { useTranslate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

export function TerminalWindowsAdministratorSection(): React.JSX.Element {
  const t = useTranslate()
  const [administrator, setAdministrator] = useState<boolean | null | undefined>()
  const [restartAvailable, setRestartAvailable] = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [manualInstructions, setManualInstructions] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState(false)
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
      ? t('settings.terminal.windows.checkingAdministrator', 'Checking…')
      : administrator === null
        ? t('settings.terminal.windows.unknownAdministrator', 'Unable to determine')
        : administrator
          ? t('settings.terminal.windows.administratorStatus', 'Administrator')
          : t('settings.terminal.windows.standardStatus', 'Standard user')

  const helpLabel = administrator
    ? t('settings.terminal.windows.returnStandardHelp', 'Standard mode guide')
    : t('settings.terminal.windows.runAdministratorHelp', 'Administrator guide')
  const restartLabel = t(
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
              {t('settings.terminal.windows.administratorLabel', 'Administrator mode')}
              <Badge variant="outline" role="status">
                {status}
              </Badge>
            </span>
          }
          description={t(
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
          size={showConfirmation ? 'confirm' : 'form'}
          busy={restarting}
          initialFocus={showConfirmation ? 'cancel' : undefined}
        >
          <DialogHeader>
            <DialogTitle>
              {showConfirmation
                ? t(
                    'settings.terminal.windows.confirmOrcaAdministratorRestart',
                    'Restart Orca as administrator?'
                  )
                : helpLabel}
            </DialogTitle>
            <DialogDescription>
              {showConfirmation
                ? t(
                    'settings.terminal.windows.administratorRestartSummary',
                    'Local terminals and agents will close. Windows will ask you to approve.'
                  )
                : t(
                    'settings.terminal.windows.administratorDialogScope',
                    'This changes permissions for the whole app. SSH and WSL keep their own permissions.'
                  )}
            </DialogDescription>
          </DialogHeader>
          {showConfirmation ? null : (
            <div className="space-y-3 text-[13px]">
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  {t(
                    'settings.terminal.windows.closeLocalSessions',
                    'Save your work, close all local terminal sessions, then exit Orca.'
                  )}
                </li>
                <li>
                  {administrator
                    ? t(
                        'settings.terminal.windows.launchStandard',
                        'Open Orca normally from the Windows Start menu.'
                      )
                    : t(
                        'settings.terminal.windows.launchAdministrator',
                        'In the Windows Start menu, right-click Orca and choose Run as administrator. Approve the Windows prompt using your usual account.'
                      )}
                </li>
              </ol>
              <p className="text-muted-foreground">
                {t(
                  'settings.terminal.windows.retainedTerminalPermissions',
                  'If new terminals still use the previous permissions, open Manage Sessions and choose Restart daemon. This closes local terminals and their running commands.'
                )}
              </p>
            </div>
          )}
          {restartError ? (
            <DialogError onRetry={() => void restartAsAdministrator()}>
              {t('settings.terminal.windows.orcaCouldNotRestart', 'Orca couldn’t restart.')}
            </DialogError>
          ) : null}
          <DialogFooter
            start={
              showConfirmation ? (
                <Button
                  variant="link-muted"
                  size="inline"
                  disabled={restarting}
                  onClick={() => {
                    setManualInstructions(true)
                    setRestartError(false)
                  }}
                >
                  {t('settings.terminal.windows.manualAdministratorSteps', 'Manual steps')}
                </Button>
              ) : (
                <Button
                  variant="link-muted"
                  size="inline"
                  onClick={(event) =>
                    openAppHttpLink('https://orca.dev/docs/terminal#windows-administrator-mode', {
                      event
                    })
                  }
                >
                  {t('settings.terminal.windows.administratorDocumentation', 'Read the guide')}
                </Button>
              )
            }
          >
            <DialogCancel>
              {showConfirmation
                ? t('settings.terminal.windows.cancelAdministratorRestart', 'Cancel')
                : t('settings.terminal.windows.closeAdministratorHelp', 'Close')}
            </DialogCancel>
            {showConfirmation ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={restarting}
                onClick={() => void restartAsAdministrator()}
              >
                {restarting
                  ? t('settings.terminal.windows.restartingAdministrator', 'Restarting…')
                  : t('settings.terminal.windows.restartOrca', 'Restart')}
              </Button>
            ) : (
              <Button size="sm" onClick={openManageSessions}>
                {t('settings.terminal.windows.10aafff216', 'Open manage sessions')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SearchableSetting>
  )
}
