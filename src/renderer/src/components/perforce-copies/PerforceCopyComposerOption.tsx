import { useEffect, useId, useState } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isCopyPlatformUnsupported } from '../../../../shared/perforce/workspace-copy/workspace-copy-platform'
import type { WorkspaceCopyReadiness } from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { isPerforceRepo } from '../../../../shared/repo-kind'
import {
  checkPerforceCopyReadiness,
  perforceCopyChoiceKey,
  usePerforceCopyComposerChoiceStore
} from './perforce-copy-composer-choice'
import { PerforceCopyRequirement } from './PerforceCopyRequirement'
import { PerforceStreamPicker } from './PerforceStreamPicker'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** One line on where the copy goes, from the readiness check's own results. */
function ReadinessLine({ readiness }: { readiness: WorkspaceCopyReadiness | null }) {
  if (!readiness) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        {translate('perforce.copies.checkingDrive', 'Checking the drive and Perforce…')}
      </p>
    )
  }
  if (readiness.problems.length > 0) {
    return (
      <p className="text-xs text-destructive">
        {readiness.problems.join(' ')}{' '}
        {translate(
          'perforce.copies.sharesFolderInstead',
          'This workspace will share the project folder instead of getting its own copy.'
        )}
      </p>
    )
  }
  const facts = [
    readiness.blockCloning === 'verified'
      ? translate('perforce.copies.blockCloningVerified', 'Block cloning verified')
      : null,
    readiness.fileSystemFreeBytes !== null
      ? translate('perforce.copies.freeOnDrive', '{{size}} free', {
          size: gb(readiness.fileSystemFreeBytes)
        })
      : null,
    readiness.copiesDir
      ? translate('perforce.copies.copiesGoIn', 'copies go in {{folder}}', {
          folder: readiness.copiesDir
        })
      : null
  ].filter(Boolean)
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p className="break-words">{facts.join(' · ')}</p>
      {readiness.warnings.map((warning) => (
        <p key={warning} className="flex gap-1.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  )
}

/**
 * Create from, for a Perforce project: each new workspace is a Perforce copy on a stream of its own,
 * as each new Git workspace is a worktree on a branch of its own. Renders nothing for other projects.
 */
export function PerforceCopyComposerOption({
  repoId,
  hostId
}: {
  repoId: string
  hostId: ExecutionHostId | null
}) {
  const isPerforce = useAppStore((s) => {
    const repo = findRepoForHost(s.repos, repoId, { hostId, settings: s.settings })
    return repo ? isPerforceRepo(repo) : false
  })
  const choiceKey = perforceCopyChoiceKey(repoId, hostId)
  const choice = usePerforceCopyComposerChoiceStore((s) => s.byRepo[choiceKey])
  const setChoice = usePerforceCopyComposerChoiceStore((s) => s.setChoice)
  const [readiness, setReadiness] = useState<WorkspaceCopyReadiness | null>(null)
  // Only an answer from the host says it cannot make copies; a failed check is shown as an error.
  const [unsupported, setUnsupported] = useState<{ windows: boolean } | null>(null)
  const labelId = useId()

  useEffect(() => {
    if (!isPerforce) {
      return
    }
    let cancelled = false
    setReadiness(null)
    setUnsupported(null)
    void checkPerforceCopyReadiness(repoId, hostId).then((result) => {
      if (cancelled) {
        return
      }
      setReadiness(
        result.ok
          ? result.value
          : {
              ready: false,
              problems: [result.error],
              warnings: [],
              source: null,
              copiesDir: null,
              windowsBuild: null,
              fileSystemFreeBytes: null,
              blockCloning: null
            }
      )
      setUnsupported(
        result.ok && isCopyPlatformUnsupported(result.value)
          ? { windows: result.value.windowsBuild !== null }
          : null
      )
    })
    return () => {
      cancelled = true
    }
  }, [isPerforce, repoId, hostId])

  if (!isPerforce) {
    return null
  }
  if (unsupported) {
    // No copy can be made here, so there is no stream to pick either.
    return <PerforceCopyRequirement unavailableHere showSetupLink={unsupported.windows} />
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <span id={labelId} className="block text-xs font-medium text-muted-foreground">
        {translate('perforce.copies.createFrom', 'Create from')}
      </span>
      <PerforceStreamPicker
        repoId={repoId}
        hostId={hostId}
        labelId={labelId}
        value={choice?.stream ?? { kind: 'child' }}
        onChange={(stream) => setChoice(choiceKey, { stream })}
      />
      <ReadinessLine readiness={readiness} />
    </div>
  )
}
