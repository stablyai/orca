import { useState } from 'react'
import { Coffee, ExternalLink, Pill, RefreshCw } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  openAmphetamineListing,
  refreshAmphetamineInstallation
} from '@/lib/amphetamine-installation'
import type { ComputerAwakeStatus, MacosAwakeEngine } from '../../../../shared/computer-awake-mode'

export function AwakeEnginePicker({
  engine,
  status,
  onChange
}: {
  engine: MacosAwakeEngine
  status: ComputerAwakeStatus
  onChange: (engine: MacosAwakeEngine) => void
}): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [actionFailure, setActionFailure] = useState<'check' | 'open' | null>(null)
  const notInstalled =
    status.amphetamineInstalled === false || status.amphetamineUnavailableReason === 'not-installed'
  const automationDenied = status.amphetamineUnavailableReason === 'automation-denied'
  const amphetamineSelectable = status.amphetamineInstalled === true
  const canRetryAvailability = !amphetamineSelectable || automationDenied
  const title = translate(
    'auto.components.status.bar.AwakeEnginePicker.label',
    'Amphetamine integration'
  )

  const checkAgain = async (): Promise<void> => {
    setChecking(true)
    setActionFailure(null)
    try {
      const installed = await refreshAmphetamineInstallation()
      if (installed === undefined) {
        setActionFailure('check')
      }
    } catch {
      setActionFailure('check')
    } finally {
      setChecking(false)
    }
  }

  const openListing = async (): Promise<void> => {
    setActionFailure(null)
    try {
      await openAmphetamineListing()
    } catch {
      setActionFailure('open')
    }
  }

  return (
    <>
      <DropdownMenuLabel>{title}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={engine} aria-label={title}>
        <DropdownMenuRadioItem
          value="caffeinate"
          aria-label={translate(
            'auto.components.status.bar.AwakeEnginePicker.builtInOnly',
            'Built-in only'
          )}
          className="items-start py-1.5"
          onSelect={(event) => {
            event.preventDefault()
            onChange('caffeinate')
          }}
        >
          <Coffee className="mt-0.5 size-3.5" />
          <span className="flex flex-col">
            <span>
              {translate(
                'auto.components.status.bar.AwakeEnginePicker.builtInOnly',
                'Built-in only'
              )}
            </span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {translate(
                'auto.components.status.bar.AwakeEnginePicker.caffeinateDescription',
                'When keep-awake is active, Orca uses Caffeinate.'
              )}
            </span>
          </span>
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value="amphetamine"
          aria-label={translate(
            'auto.components.status.bar.AwakeEnginePicker.addAmphetamine',
            'Amphetamine (read-only)'
          )}
          className="items-start py-1.5"
          disabled={!amphetamineSelectable}
          onSelect={(event) => {
            event.preventDefault()
            onChange('amphetamine')
          }}
        >
          <Pill className="mt-0.5 size-3.5" />
          <span className="flex flex-col">
            <span>
              {translate(
                'auto.components.status.bar.AwakeEnginePicker.addAmphetamine',
                'Amphetamine (read-only)'
              )}
            </span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {translate(
                'auto.components.status.bar.AwakeEnginePicker.amphetamineDescription',
                'Orca still uses Caffeinate; this only observes a session you start manually or with a Trigger. It never starts or stops Amphetamine.'
              )}
            </span>
          </span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {notInstalled ? (
        <p className="px-2 py-1 text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.status.bar.AwakeEnginePicker.missingDescription',
            'Install Amphetamine to let Orca observe a session you start manually or with a Trigger; Orca never starts or stops it.'
          )}
        </p>
      ) : automationDenied ? (
        <p className="px-2 py-1 text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.status.bar.AwakeEnginePicker.automationDenied',
            'When keep-awake is active, Orca uses Caffeinate. Orca only observes Amphetamine session activity. Allow Orca in System Settings › Privacy & Security › Automation, then check again.'
          )}
        </p>
      ) : null}
      {canRetryAvailability ? <DropdownMenuSeparator /> : null}
      {notInstalled ? (
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            void openListing()
          }}
        >
          <ExternalLink />
          {translate(
            'auto.components.status.bar.AwakeEnginePicker.getAmphetamine',
            'Get Amphetamine…'
          )}
        </DropdownMenuItem>
      ) : null}
      {canRetryAvailability ? (
        <DropdownMenuItem
          disabled={checking}
          onSelect={(event) => {
            event.preventDefault()
            void checkAgain()
          }}
        >
          <RefreshCw className={checking ? 'animate-spin' : undefined} />
          {checking
            ? translate('auto.components.status.bar.AwakeEnginePicker.checking', 'Checking…')
            : translate('auto.components.status.bar.AwakeEnginePicker.checkAgain', 'Check again')}
        </DropdownMenuItem>
      ) : null}
      {actionFailure ? (
        <p role="alert" className="px-2 py-1 text-[11px] leading-4 text-destructive">
          {actionFailure === 'open'
            ? translate(
                'auto.components.status.bar.AwakeEnginePicker.openFailed',
                'Couldn’t open the Amphetamine listing. Try again.'
              )
            : translate(
                'auto.components.status.bar.AwakeEnginePicker.checkFailed',
                'Couldn’t check for Amphetamine. Try again.'
              )}
        </p>
      ) : null}
    </>
  )
}
