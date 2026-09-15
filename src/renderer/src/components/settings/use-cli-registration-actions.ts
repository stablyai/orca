import { useCallback, useState, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { translate } from '@/i18n/i18n'
import {
  readCliInstallFailure,
  readCliInstallRejection,
  type CliInstallFailure
} from './cli-install-failure'

type CliRegistrationActionsOptions = {
  commandName: string
  mountedRef: MutableRefObject<boolean>
  onStatusChange: (status: CliInstallStatus) => void
  onSettled: () => void
}

export type CliRegistrationActions = {
  busyAction: 'install' | 'remove' | null
  installFailure: CliInstallFailure | null
  clearInstallFailure: () => void
  install: () => Promise<void>
  remove: () => Promise<void>
}

function unknownReason(): string {
  return translate(
    'auto.components.settings.CliSection.installFailureUnknownReason',
    'Orca could not finish CLI registration and reported no reason.'
  )
}

function failedTitle(commandName: string): string {
  return translate(
    'auto.components.settings.CliSection.a2b13efa94',
    'Failed to register `{{value0}}` in PATH.',
    { value0: commandName }
  )
}

export function useCliRegistrationActions({
  commandName,
  mountedRef,
  onStatusChange,
  onSettled
}: CliRegistrationActionsOptions): CliRegistrationActions {
  const [busyAction, setBusyAction] = useState<'install' | 'remove' | null>(null)
  const [installFailure, setInstallFailure] = useState<CliInstallFailure | null>(null)
  const clearInstallFailure = useCallback((): void => setInstallFailure(null), [])

  const install = useCallback(async (): Promise<void> => {
    setBusyAction('install')
    try {
      const next = await window.api.cli.install()
      if (!mountedRef.current) {
        return
      }
      onStatusChange(next)
      onSettled()
      // Why: `install()` resolves with the post-registration status, so a refusal
      // (conflict, unsupported build, unreadable PATH) arrives as data, not a throw.
      const failure = readCliInstallFailure(next, unknownReason())
      setInstallFailure(failure)
      if (failure) {
        toast.error(failedTitle(next.commandName), { description: failure.reason })
        return
      }
      toast.success(
        translate(
          'auto.components.settings.CliSection.9cbcd31338',
          'Registered `{{value0}}` in PATH.',
          { value0: next.commandName }
        )
      )
    } catch (error) {
      if (!mountedRef.current) {
        return
      }
      const failure = readCliInstallRejection(error, unknownReason())
      setInstallFailure(failure)
      // Why: closing reveals the persistent notice the toast is only a preview of.
      onSettled()
      toast.error(failedTitle(commandName), { description: failure.reason })
    } finally {
      if (mountedRef.current) {
        setBusyAction(null)
      }
    }
  }, [commandName, mountedRef, onSettled, onStatusChange])

  const remove = useCallback(async (): Promise<void> => {
    setBusyAction('remove')
    try {
      const next = await window.api.cli.remove()
      if (mountedRef.current) {
        onStatusChange(next)
        onSettled()
        setInstallFailure(null)
        toast.success(
          translate(
            'auto.components.settings.CliSection.af5540930c',
            'Removed `{{value0}}` from PATH.',
            { value0: next.commandName }
          )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.CliSection.d77352f2df',
                'Failed to remove `{{value0}}` from PATH.',
                { value0: commandName }
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyAction(null)
      }
    }
  }, [commandName, mountedRef, onSettled, onStatusChange])

  return { busyAction, installFailure, clearInstallFailure, install, remove }
}
