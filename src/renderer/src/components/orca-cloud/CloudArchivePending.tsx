// ARCHIVE-NOW: what the archived page shows while Archive is still running: the state line, the
// copy that goes with it, and the archive hook's failure with its output and the choice.
import React from 'react'
import { Archive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { OptimisticArchive } from '@/lib/orca-cloud/optimistic-cloud-archive'
import { archiveHookOutputTail, describeArchiveHookFailure } from './cloud-archive-hook-flow'

export function archivePendingStateLine(t: Translate, pending: OptimisticArchive): string {
  if (pending.phase === 'hook-failed') {
    return t('orcaCloudWorkspace.archiveNow.notYet', 'Not archived yet')
  }
  if (pending.phase === 'archiving' && pending.step === 'hook-waking') {
    return t('orcaCloudWorkspace.archiveNow.hookWaking', 'Waking to run its archive script…')
  }
  if (pending.phase === 'archiving' && pending.step === 'hook') {
    return t('orcaCloudWorkspace.archiveNow.hookRunning', 'Running its archive script…')
  }
  return t('orcaCloudWorkspace.archiveNow.archiving', 'Archiving…')
}

export function CloudArchivePendingBody({
  pending,
  skeleton
}: {
  pending: OptimisticArchive
  skeleton: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  if (pending.phase === 'hook-failed') {
    const output = archiveHookOutputTail(pending.failure.runs)
    return (
      <InlineError
        title={t('orcaCloudWorkspace.archiveNow.hookFailed', 'Its archive script failed')}
        detail={describeArchiveHookFailure(pending.failure)}
      >
        {output ? (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-2xs whitespace-pre-wrap text-muted-foreground scrollbar-sleek">
            {output}
          </pre>
        ) : null}
        <div className="mt-2 flex gap-2">
          <Button size="xs" variant="outline" onClick={() => pending.decide(true)}>
            <Archive />
            {t('orcaCloudWorkspace.archiveHook.archiveAnyway', 'Archive anyway')}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => pending.decide(false)}>
            {t('orcaCloudWorkspace.archiveHook.keep', 'Keep it')}
          </Button>
        </div>
      </InlineError>
    )
  }
  const localCopy = pending.phase === 'undo' ? pending.localCopy : undefined
  return (
    <>
      {localCopy ? (
        <p className="max-w-[60ch] text-sm text-muted-foreground" data-cloud-sync-removal>
          {localCopy.editedHere > 0
            ? t(
                'orcaCloudSync.removalEdited',
                '{{count}} changed files on this computer will be removed.',
                {
                  count: localCopy.editedHere,
                  defaultValue_one: '{{count}} changed file on this computer will be removed.'
                }
              )
            : t('orcaCloudSync.removal', 'The copy on this computer is removed too.')}
        </p>
      ) : null}
      {skeleton}
    </>
  )
}
