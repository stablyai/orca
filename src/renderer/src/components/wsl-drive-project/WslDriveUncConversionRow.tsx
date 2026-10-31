import React, { useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { Repo } from '../../../../shared/repo-types'
import type { WslDriveUncConversionResult } from '../../../../shared/wsl-drive-unc-conversion-types'
import { parseWslUncPath, wslUncDrivePathToWindows } from '../../../../shared/wsl-paths'
import { SettingsRow } from '../settings/SettingsFormControls'
import { wslDriveUncConversionMessages } from './wsl-drive-unc-conversion-copy'

type Step =
  | { kind: 'idle' }
  | { kind: 'review' }
  | { kind: 'converting' }
  | { kind: 'problem'; messages: string[] }

/**
 * A project Orca opens through WSL's view of a Windows drive (`\\wsl.localhost\<d>\mnt\c\x`): Git
 * there is ~300x slower than Git for Windows, so Orca offers to reopen it at its drive path, with
 * terminals and agents still in the distro. Converting restarts Orca.
 */
export function WslDriveUncConversionRow({
  repo
}: {
  repo: Pick<Repo, 'id' | 'path'>
}): React.JSX.Element | null {
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const distro = parseWslUncPath(repo.path)?.distro
  const drivePath = distro ? wslUncDrivePathToWindows(repo.path, distro) : null
  if (!distro || !drivePath) {
    return null
  }
  const convert = async (): Promise<void> => {
    setStep({ kind: 'converting' })
    let result: WslDriveUncConversionResult
    try {
      result = await window.api.wslDriveUnc.convert({ distro, repoIds: [repo.id] })
    } catch {
      setStep({ kind: 'idle' })
      toast.error(translate('wslDriveUnc.failed', 'Orca could not convert this project.'))
      return
    }
    if (result.outcome === 'restarting') {
      toast(translate('wslDriveUnc.restarting', 'Restarting Orca to convert this project…'))
      return
    }
    setStep({ kind: 'problem', messages: wslDriveUncConversionMessages(result, drivePath) })
  }
  return (
    <div className="space-y-2">
      <SettingsRow
        label={translate('wslDriveUnc.label', 'Location')}
        alignTop
        description={translate(
          'wslDriveUnc.description',
          'Orca opens this project through WSL. Open it at {{drivePath}} instead: Git runs on Windows, which is much faster here, and terminals and agents stay in {{distro}}.',
          { drivePath, distro }
        )}
        control={
          step.kind === 'review' || step.kind === 'converting' ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setStep({ kind: 'review' })}
            >
              {translate('wslDriveUnc.convert', 'Open at {{drivePath}}', { drivePath })}
            </Button>
          )
        }
      />
      {step.kind === 'problem' ? (
        <div role="alert" className="space-y-1 text-xs text-muted-foreground">
          {step.messages.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      {step.kind === 'review' || step.kind === 'converting' ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {translate(
              'wslDriveUnc.review',
              'Orca pauses this project’s terminals, restarts, and reopens it at {{drivePath}}. Tabs, terminals with their history, chats and settings come along, and paused terminals pick up where they were.',
              { drivePath }
            )}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={step.kind === 'converting'}
              onClick={() => setStep({ kind: 'idle' })}
            >
              {translate('wslDriveUnc.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={step.kind === 'converting'}
              onClick={() => void convert()}
            >
              {translate('wslDriveUnc.confirm', 'Restart and convert')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
