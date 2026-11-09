import React, { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import type { ProjectUpdateArgs } from '../../../../shared/project-types'
import type { WslDriveProjectPreview } from '../../../../shared/wsl-drive-project-types'
import { SettingsRow } from '../settings/form-controls/SettingsFormControls'
import { wslDriveProjectBlockerMessage } from './wsl-drive-project-copy'

type Step =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'review'; preview: WslDriveProjectPreview }
  | { kind: 'converting'; preview: WslDriveProjectPreview }

/**
 * Git row of a WSL-runtime project on a Windows drive: WSL Git there is ~300x slower and misses
 * Windows-side edits, so Orca offers Windows Git while terminals and agents stay in WSL.
 */
export function WslDriveProjectGitRow({
  projectId,
  repoPath,
  resolution,
  acceptsNewWork,
  updateProject
}: {
  projectId: string
  repoPath: string
  resolution: ProjectExecutionRuntimeResolution
  /** False in serve-only, after a live block or with the setting off: no new conversion. */
  acceptsNewWork: boolean
  updateProject: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
}): React.JSX.Element | null {
  const t = useTranslate()
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [alignLineEndings, setAlignLineEndings] = useState(true)
  if (!isWslDriveProject(resolution, repoPath)) {
    return null
  }
  if (resolution.runtime.git === 'windows-host') {
    return (
      <SettingsRow
        label={t('wslDriveProject.label', 'Git')}
        description={t(
          'wslDriveProject.converted',
          'Orca runs Git on Windows for this project. Terminals and agents still run in {{distro}}.',
          { distro: resolution.runtime.distro }
        )}
        control={null}
      />
    )
  }
  // The converted state above always shows, since its preference still applies; the offer does not.
  if (!acceptsNewWork) {
    return null
  }
  const check = async (): Promise<void> => {
    setStep({ kind: 'checking' })
    try {
      setStep({ kind: 'review', preview: await window.api.wslDriveProject.preview(projectId) })
    } catch {
      setStep({ kind: 'idle' })
      toast.error(t('wslDriveProject.checkFailed', 'Orca could not check this project.'))
    }
  }
  const convert = async (preview: WslDriveProjectPreview): Promise<void> => {
    setStep({ kind: 'converting', preview })
    try {
      const result = await window.api.wslDriveProject.convert({ projectId, alignLineEndings })
      if (!result.ok) {
        setStep({ kind: 'review', preview: { ...preview, blockers: result.blockers } })
        return
      }
      await updateProject(projectId, { localWindowsRuntimePreference: result.preference })
      setStep({ kind: 'idle' })
    } catch {
      setStep({ kind: 'review', preview })
      toast.error(t('wslDriveProject.convertFailed', 'Orca could not switch Git.'))
    }
  }
  const preview = step.kind === 'review' || step.kind === 'converting' ? step.preview : null
  const offersLineEndings = preview?.repos.some(
    (repo) => repo.windowsAutocrlf === 'true' && repo.localAutocrlf === null
  )
  return (
    <div className="space-y-2">
      <SettingsRow
        label={t('wslDriveProject.label', 'Git')}
        alignTop
        description={t(
          'wslDriveProject.description',
          'This project is on a Windows drive, where Git in WSL is slow and misses changes made in Windows. Use Git for Windows instead; terminals and agents stay in {{distro}}.',
          { distro: resolution.runtime.distro }
        )}
        control={
          preview ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={step.kind === 'checking'}
              onClick={() => void check()}
            >
              {t('wslDriveProject.useWindowsGit', 'Use Git for Windows')}
            </Button>
          )
        }
      />
      {preview && preview.blockers.length > 0 ? (
        <div role="alert" className="space-y-1 text-xs text-muted-foreground">
          {preview.blockers.map((blocker) => (
            <p key={`${blocker.kind}:${'repoId' in blocker ? blocker.repoId : ''}`}>
              {wslDriveProjectBlockerMessage(blocker, t)}
            </p>
          ))}
        </div>
      ) : null}
      {preview && preview.blockers.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t(
              'wslDriveProject.review',
              'Nothing in Orca changes for this project: its tabs, terminals, chats and workspaces stay as they are. Running terminals keep going.'
            )}
          </p>
          {offersLineEndings ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id={`wsl-drive-line-endings-${projectId}`}
                checked={alignLineEndings}
                onCheckedChange={(checked) => setAlignLineEndings(checked === true)}
              />
              <Label htmlFor={`wsl-drive-line-endings-${projectId}`}>
                {t(
                  'wslDriveProject.lineEndings',
                  'Also set core.autocrlf in this repo, so git in WSL terminals stops showing every file as changed.'
                )}
              </Label>
            </div>
          ) : null}
        </div>
      ) : null}
      {preview ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep({ kind: 'idle' })}>
            {t('wslDriveProject.cancel', 'Cancel')}
          </Button>
          {preview.blockers.length === 0 ? (
            <Button
              type="button"
              size="sm"
              disabled={step.kind === 'converting'}
              onClick={() => void convert(preview)}
            >
              {t('wslDriveProject.confirm', 'Use Git for Windows')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function isWslDriveProject(
  resolution: ProjectExecutionRuntimeResolution,
  repoPath: string
): resolution is Extract<ProjectExecutionRuntimeResolution, { status: 'resolved' }> & {
  runtime: { kind: 'wsl' }
} {
  return (
    resolution.status === 'resolved' &&
    resolution.runtime.kind === 'wsl' &&
    /^[A-Za-z]:[\\/]/.test(repoPath)
  )
}
