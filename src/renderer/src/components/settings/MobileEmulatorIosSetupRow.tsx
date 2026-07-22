import { Copy, ExternalLink, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { IosSetupStatus } from '../../../../shared/emulator-setup-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { MobileEmulatorToolchainRow } from './MobileEmulatorToolchainRow'

const XCODE_URL = 'https://apps.apple.com/app/xcode/id497799835'

type Action = 'select' | 'first-launch' | null

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function MobileEmulatorIosSetupRow({
  status,
  helper,
  localActionsAvailable,
  onRefresh
}: {
  status: IosSetupStatus
  helper: { ok: boolean; message?: string }
  localActionsAvailable: boolean
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [action, setAction] = useState<Action>(null)
  const [error, setError] = useState<string | null>(null)
  const xcode = status.recommendedXcode
  const ready = status.state === 'ready' && helper.ok

  const runSetup = async (nextAction: Exclude<Action, null>): Promise<void> => {
    if (!xcode || action) {
      return
    }
    setAction(nextAction)
    setError(null)
    try {
      const result =
        nextAction === 'select'
          ? await window.api.emulatorSetup.useInstalledXcode(xcode.developerDir)
          : await window.api.emulatorSetup.finishXcodeSetup(xcode.developerDir)
      if (!result.ok) {
        setError(result.message || 'Xcode setup did not finish.')
      } else {
        await onRefresh()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Xcode setup did not finish.')
    } finally {
      setAction(null)
    }
  }

  const openXcode = async (): Promise<void> => {
    if (!xcode) {
      return
    }
    try {
      const result = await window.api.emulatorSetup.openXcode(xcode.developerDir)
      if (!result.ok) {
        setError(result.message || 'Could not open Xcode.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open Xcode.')
    }
  }

  const copyCommand = async (): Promise<void> => {
    if (!xcode) {
      return
    }
    const command =
      status.state === 'xcode-selection-required'
        ? `sudo xcode-select --switch ${quoteShell(xcode.developerDir)} && sudo ${quoteShell(`${xcode.developerDir}/usr/bin/xcodebuild`)} -runFirstLaunch`
        : status.state === 'xcode-first-launch-required'
          ? `sudo ${quoteShell(`${xcode.developerDir}/usr/bin/xcodebuild`)} -runFirstLaunch`
          : `DEVELOPER_DIR=${quoteShell(xcode.developerDir)} xcodebuild -downloadPlatform iOS`
    try {
      await navigator.clipboard.writeText(command)
      toast.success(
        translate('auto.components.settings.MobileEmulatorIosSetupRow.copy', 'Command copied')
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not copy the command.')
    }
  }

  const actions = (): React.ReactNode => {
    if (!localActionsAvailable || status.state === 'unsupported' || status.state === 'ready') {
      return null
    }
    if (status.state === 'xcode-missing') {
      return (
        <Button type="button" size="sm" onClick={() => void window.api.shell.openUrl(XCODE_URL)}>
          {translate(
            'auto.components.settings.MobileEmulatorIosSetupRow.download',
            'Download Xcode'
          )}
        </Button>
      )
    }
    if (status.state === 'xcode-selection-required' && xcode) {
      return (
        <>
          <Button
            type="button"
            size="sm"
            onClick={() => void runSetup('select')}
            disabled={Boolean(action)}
          >
            {action === 'select' ? <Loader2 className="animate-spin" /> : null}
            {action === 'select'
              ? translate(
                  'auto.components.settings.MobileEmulatorIosSetupRow.selecting',
                  'Setting up Xcode…'
                )
              : translate(
                  'auto.components.settings.MobileEmulatorIosSetupRow.use',
                  'Use Installed Xcode'
                )}
          </Button>
          <SecondaryXcodeActions onOpen={openXcode} onCopy={copyCommand} />
        </>
      )
    }
    if (status.state === 'xcode-first-launch-required' && xcode) {
      return (
        <>
          <Button
            type="button"
            size="sm"
            onClick={() => void runSetup('first-launch')}
            disabled={Boolean(action)}
          >
            {action === 'first-launch' ? <Loader2 className="animate-spin" /> : null}
            {action === 'first-launch'
              ? translate(
                  'auto.components.settings.MobileEmulatorIosSetupRow.finishing',
                  'Installing components…'
                )
              : translate(
                  'auto.components.settings.MobileEmulatorIosSetupRow.finish',
                  'Finish Xcode Setup'
                )}
          </Button>
          <SecondaryXcodeActions onOpen={openXcode} onCopy={copyCommand} />
        </>
      )
    }
    if (!xcode) {
      return null
    }
    return (
      <SecondaryXcodeActions
        onOpen={openXcode}
        onCopy={status.state === 'simulator-runtime-missing' ? copyCommand : undefined}
        primary
      />
    )
  }

  return (
    <MobileEmulatorToolchainRow
      ready={ready}
      title={translate('auto.components.settings.MobileEmulatorIosSetupRow.title', 'iOS Simulator')}
      detail={
        status.state === 'ready' && !helper.ok
          ? helper.message || 'Orca Simulator support is unavailable.'
          : status.message
      }
      actions={actions()}
      error={error}
    />
  )
}

function SecondaryXcodeActions({
  onOpen,
  onCopy,
  primary = false
}: {
  onOpen: () => Promise<void>
  onCopy?: () => Promise<void>
  primary?: boolean
}): React.JSX.Element {
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={primary ? 'default' : 'outline'}
        onClick={() => void onOpen()}
      >
        <ExternalLink />
        {translate('auto.components.settings.MobileEmulatorIosSetupRow.open', 'Open Xcode')}
      </Button>
      {onCopy ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => void onCopy()}>
          <Copy />
          {translate(
            'auto.components.settings.MobileEmulatorIosSetupRow.copyCommand',
            'Copy command'
          )}
        </Button>
      ) : null}
    </>
  )
}
