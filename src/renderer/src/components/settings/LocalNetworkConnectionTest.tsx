import { useState, type FormEvent } from 'react'
import { CheckCircle2, ChevronDown } from 'lucide-react'
import type {
  LocalNetworkConnectionTestFailure,
  LocalNetworkConnectionTestResult
} from '../../../../shared/developer-permissions-types'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  loadLocalNetworkConnectionSuccess,
  saveLocalNetworkConnectionSuccess,
  type LocalNetworkConnectionSuccess
} from './local-network-connection-history'

function failureMessage(failure: LocalNetworkConnectionTestFailure | undefined): string {
  switch (failure) {
    case 'invalid-target':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.connectionTestInvalidTarget',
        'Enter a hostname or private LAN IP and a port from 1 to 65535.'
      )
    case 'timeout':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.connectionTestTimeout',
        'Connection timed out. Check the target, service, and macOS Local Network settings.'
      )
    case 'refused':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.connectionTestRefused',
        'The host responded, but the port refused the connection.'
      )
    case 'unreachable':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.connectionTestUnreachable',
        'The target could not be reached.'
      )
    case 'unresolved':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.connectionTestUnresolved',
        'The hostname could not be resolved.'
      )
    case 'unsupported':
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.connectionTestUnsupported',
        'Connection testing is available in the macOS desktop app.'
      )
    case 'failed':
    case undefined:
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.connectionTestFailed',
        'The connection test could not be completed.'
      )
  }
}

function formatTarget(success: LocalNetworkConnectionSuccess): string {
  return `${success.host}:${success.port}`
}

export function LocalNetworkConnectionTest(): React.JSX.Element {
  const [lastSuccess, setLastSuccess] = useState(loadLocalNetworkConnectionSuccess)
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState(lastSuccess?.host ?? '')
  const [port, setPort] = useState(lastSuccess ? String(lastSuccess.port) : '')
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<LocalNetworkConnectionTestFailure | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setRunning(true)
    setFailure(null)
    try {
      const result: LocalNetworkConnectionTestResult =
        await window.api.developerPermissions.testLocalNetworkConnection({
          host,
          port: Number(port)
        })
      if (result.ok) {
        const success = {
          host: result.host,
          port: result.port,
          testedAt: result.testedAt
        }
        saveLocalNetworkConnectionSuccess(success)
        setLastSuccess(success)
      } else {
        setFailure(result.failure ?? 'failed')
      }
    } catch {
      setFailure('failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mr-4 mb-3 ml-11">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-between px-3 py-2 text-left"
        >
          <span className="min-w-0 space-y-0.5">
            <span className="block text-xs font-medium text-foreground">
              {translate(
                'auto.components.settings.DeveloperPermissionsPane.connectionTestTitle',
                'Test connection'
              )}
            </span>
            <span
              className={cn(
                'flex items-center gap-1.5 text-xs font-normal',
                lastSuccess ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'
              )}
            >
              {lastSuccess && <CheckCircle2 className="size-3.5" />}
              {lastSuccess ? (
                <>
                  {translate(
                    'auto.components.settings.DeveloperPermissionsPane.connectionTestLastVerified',
                    'Last verified'
                  )}{' '}
                  {new Date(lastSuccess.testedAt).toLocaleString()} · {formatTarget(lastSuccess)}
                </>
              ) : (
                translate(
                  'auto.components.settings.DeveloperPermissionsPane.connectionTestNotYetVerified',
                  'No successful test saved.'
                )
              )}
            </span>
          </span>
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-height-content">
        <div className="mt-2 rounded-lg border border-border/60 bg-muted/25 px-4 py-3 shadow-xs">
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.DeveloperPermissionsPane.connectionTestDescription',
              'Enter a service on another device on your local network. Orca tests the same network path used by terminal tools.'
            )}
          </p>
          {failure && (
            <p className="mt-1 text-xs text-destructive" role="status">
              {failureMessage(failure)}
            </p>
          )}
          <form className="mt-3 flex items-end gap-2" onSubmit={(event) => void submit(event)}>
            <div className="space-y-1">
              <Label htmlFor="local-network-test-host" className="text-[11px]">
                {translate(
                  'auto.components.settings.DeveloperPermissionsPane.connectionTestHost',
                  'Host'
                )}
              </Label>
              <Input
                id="local-network-test-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="192.168.1.20"
                autoComplete="off"
                className="w-44"
                disabled={running}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="local-network-test-port" className="text-[11px]">
                {translate(
                  'auto.components.settings.DeveloperPermissionsPane.connectionTestPort',
                  'Port'
                )}
              </Label>
              <Input
                id="local-network-test-port"
                type="number"
                min={1}
                max={65_535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="3000"
                className="w-24"
                disabled={running}
              />
            </div>
            <Button type="submit" variant="outline" disabled={running || !host || !port}>
              {running
                ? translate(
                    'auto.components.settings.DeveloperPermissionsPane.connectionTestRunning',
                    'Testing...'
                  )
                : translate(
                    'auto.components.settings.DeveloperPermissionsPane.connectionTestAction',
                    'Test Connection'
                  )}
            </Button>
          </form>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
