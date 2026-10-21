import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useRepositoryAddScriptResultStore } from '@/store/repository-add-script-result'
import { RepositoryAddScriptNotSentError } from '../../../shared/repository-add-script-errors'
import type {
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptIdentity,
  RepositoryAddScriptOutcome,
  RepositoryAddScriptPreview,
  RepositoryAddScriptPromptDecision
} from '../../../shared/repository-add-script-types'
import {
  decideRepositoryAddScript,
  getRepositoryAddScriptOutcome
} from './repository-add-script-decision-route'

const SUCCESS_TOAST_DURATION_MS = 4_000
const REJECTED_TOAST_DURATION_MS = 6_000
const NOT_SENT_TOAST_DURATION_MS = 6_000

function toastIdFor(token: string): string {
  return `repository-add-script:${token}`
}

function identityOf(preview: RepositoryAddScriptPreview): RepositoryAddScriptIdentity {
  return { token: preview.token, hostId: preview.hostId, repoId: preview.repoId }
}

function isTerminal(
  outcome: RepositoryAddScriptOutcome | RepositoryAddScriptDecisionResult
): boolean {
  return outcome.status !== 'pending' && outcome.status !== 'running'
}

function showUnconfirmed(preview: RepositoryAddScriptPreview): void {
  toast.warning(
    translate(
      'auto.runtime.repositoryAddScriptExecution.unconfirmedTitle',
      "Can't confirm the add script finished"
    ),
    {
      id: toastIdFor(preview.token),
      description: translate(
        'auto.runtime.repositoryAddScriptExecution.unconfirmedDescription',
        'Orca lost contact with {{host}} while the script was running. It may still be running.',
        { host: preview.hostLabel }
      ),
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: translate('auto.runtime.repositoryAddScriptExecution.checkAgain', 'Check again'),
        onClick: (event) => {
          // Why: Sonner otherwise dismisses the keyed toast after the action runs.
          event.preventDefault()
          void readOutcomeOnceAndPresent(preview, { showChecking: true })
        }
      }
    }
  )
}

/** The request never left this client, so no outcome can exist and nothing can be running. */
function showNotSent(preview: RepositoryAddScriptPreview): void {
  toast.warning(
    translate(
      'auto.runtime.repositoryAddScriptExecution.notStartedTitle',
      'The add script was not started'
    ),
    {
      id: toastIdFor(preview.token),
      description: translate(
        'auto.runtime.repositoryAddScriptExecution.notStartedDescription',
        'Orca could not send this request to {{host}}. Nothing ran.',
        { host: preview.hostLabel }
      ),
      duration: NOT_SENT_TOAST_DURATION_MS
    }
  )
}

/** Reads the outcome once and presents it, or warns that its fate stays unknown. */
async function readOutcomeOnceAndPresent(
  preview: RepositoryAddScriptPreview,
  { showChecking }: { showChecking: boolean }
): Promise<void> {
  if (showChecking) {
    toast.loading(
      translate('auto.runtime.repositoryAddScriptExecution.checking', 'Checking add script…'),
      {
        id: toastIdFor(preview.token),
        description: preview.path,
        duration: Number.POSITIVE_INFINITY
      }
    )
  }
  try {
    const outcome = await getRepositoryAddScriptOutcome(identityOf(preview))
    if (outcome && isTerminal(outcome)) {
      presentOutcome(outcome, preview)
      return
    }
  } catch (error) {
    console.warn('[repository-add-script] outcome read failed:', error)
  }
  showUnconfirmed(preview)
}

function presentOutcome(
  outcome: RepositoryAddScriptOutcome | RepositoryAddScriptDecisionResult,
  preview: RepositoryAddScriptPreview
): void {
  const toastId = toastIdFor(preview.token)
  const showResult = useRepositoryAddScriptResultStore.getState().showRepositoryAddScriptResult
  const shared = {
    path: preview.path,
    hostLabel: preview.hostLabel
  }

  switch (outcome.status) {
    case 'succeeded':
      toast.success(
        translate('auto.runtime.repositoryAddScriptExecution.finished', 'Add script finished'),
        {
          id: toastId,
          description: preview.path,
          duration: SUCCESS_TOAST_DURATION_MS
        }
      )
      return
    case 'failed':
      toast.dismiss(toastId)
      if ('reason' in outcome) {
        showResult({
          status: 'failed',
          reason: outcome.reason,
          ...shared,
          output: '',
          outputTruncated: false
        })
        return
      }
      showResult({
        status: 'failed',
        ...shared,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        output: outcome.output,
        outputTruncated: outcome.outputTruncated
      })
      return
    case 'unverifiable':
      toast.dismiss(toastId)
      showResult({
        status: 'unverifiable',
        ...shared,
        output: outcome.output,
        outputTruncated: outcome.outputTruncated
      })
      return
    case 'rejected':
      toast.warning(
        translate(
          'auto.runtime.repositoryAddScriptExecution.rejectedTitle',
          'The add script was not started'
        ),
        {
          id: toastId,
          description: translate(
            'auto.runtime.repositoryAddScriptExecution.rejectedDescription',
            'Orca refused this add script request. Add the repository again to get a new prompt.'
          ),
          duration: REJECTED_TOAST_DURATION_MS
        }
      )
      return
    case 'pending':
    case 'running':
      showUnconfirmed(preview)
      return
    case 'skipped':
    case 'stale':
    case 'revoked':
      // The user resolved this prompt elsewhere; a result dialog would be noise.
      toast.dismiss(toastId)
  }
}

/**
 * Runs the decision the prompt produced. The prompt leaves the screen before this starts, so a
 * long script never blocks the queue, and a failed decision is never re-sent: only the outcome for
 * the same token, host and repo is read.
 */
export async function resolveRepositoryAddScriptPrompt(
  preview: RepositoryAddScriptPreview,
  decision: RepositoryAddScriptPromptDecision
): Promise<void> {
  if (decision === 'skip') {
    try {
      await decideRepositoryAddScript({ ...identityOf(preview), decision: 'skip' })
    } catch (error) {
      console.warn('[repository-add-script] skip decision failed:', error)
    }
    return
  }

  toast.loading(
    translate('auto.runtime.repositoryAddScriptExecution.running', 'Running add script…'),
    {
      id: toastIdFor(preview.token),
      description: preview.path,
      duration: Number.POSITIVE_INFINITY
    }
  )

  try {
    const outcome = await decideRepositoryAddScript({ ...identityOf(preview), decision: 'run' })
    presentOutcome(outcome, preview)
  } catch (error) {
    console.warn('[repository-add-script] run decision failed:', error)
    if (error instanceof RepositoryAddScriptNotSentError) {
      showNotSent(preview)
      return
    }
    await readOutcomeOnceAndPresent(preview, { showChecking: false })
  }
}
