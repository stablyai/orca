/* eslint-disable max-lines -- Why: field state, base search, AI generation,
   and cancellation share request guards that need to stay in one hook. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore, type AppState } from '@/store'
import {
  cancelRuntimeGeneratePullRequestFields,
  generateRuntimePullRequestFields,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'
import {
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../../../shared/commit-message-agent-spec'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'

type UseCreatePullRequestDialogFieldsOptions = {
  open: boolean
  repoId: string
  worktreeId: string | null
  worktreePath: string
  branch: string
  eligibility: HostedReviewCreationEligibility | null
  settings: AppState['settings']
  submitting: boolean
  onBranchChangedByGeneration?: () => Promise<void>
  generation?: {
    generating: boolean
    generateError: string | null
    onGenerate: (fields: { base: string; title: string; body: string; draft: boolean }) => void
    onCancelGenerate: () => void
  }
}

type GenerationSeed = {
  requestId: number
  base: string
  title: string
  body: string
  draft: boolean
  context: RuntimeGitContext
}

export function stripBaseRef(ref: string): string {
  return normalizeHostedReviewBaseRef(ref)
}

export function useCreatePullRequestDialogFields({
  open,
  repoId,
  worktreeId,
  worktreePath,
  branch,
  eligibility,
  settings,
  submitting,
  onBranchChangedByGeneration,
  generation
}: UseCreatePullRequestDialogFieldsOptions) {
  const commitMessageAi = settings?.commitMessageAi
  const effectiveCommitMessageAgentId = resolveCommitMessageAgentChoice(
    commitMessageAi?.agentId,
    settings?.defaultTuiAgent
  )
  const initializedFromEligibilityRef = useRef<string | null>(null)
  const generateInFlightRef = useRef(false)
  const generationRequestIdRef = useRef(0)
  const generationSeedRef = useRef<GenerationSeed | null>(null)
  const latestFieldsRef = useRef({
    base: '',
    title: '',
    body: '',
    draft: false
  })
  const [base, setBase] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [baseQuery, setBaseQuery] = useState('')
  const [baseResults, setBaseResults] = useState<string[]>([])
  const [baseSearchError, setBaseSearchError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const hasExternalGeneration = Boolean(generation)

  useEffect(() => {
    latestFieldsRef.current = { base, title, body, draft }
  }, [base, body, draft, title])

  useEffect(() => {
    if (!open) {
      if (!hasExternalGeneration) {
        generationRequestIdRef.current += 1
        if (generateInFlightRef.current) {
          const requestContext = generationSeedRef.current?.context
          if (requestContext?.worktreePath) {
            void cancelRuntimeGeneratePullRequestFields(requestContext)
          }
        }
        generateInFlightRef.current = false
        generationSeedRef.current = null
        initializedFromEligibilityRef.current = null
        setGenerating(false)
        setGenerateError(null)
      }
      return
    }
    if (!eligibility) {
      return
    }
    const initializationKey = `${repoId}:${worktreeId ?? worktreePath}:${branch}`
    if (initializedFromEligibilityRef.current === initializationKey) {
      return
    }
    // Why: eligibility refreshes while the dialog is open; only seed fields
    // once per branch so late refreshes do not overwrite user edits.
    initializedFromEligibilityRef.current = initializationKey
    const initialBase = eligibility.defaultBaseRef ?? ''
    setBase(stripBaseRef(initialBase))
    setTitle(eligibility.title ?? '')
    setBody(eligibility.body ?? '')
    setDraft(false)
    setBaseQuery('')
    setBaseResults([])
    setBaseSearchError(null)
    setGenerateError(null)
  }, [branch, eligibility, hasExternalGeneration, open, repoId, worktreeId, worktreePath])

  const effectiveGenerating = generation?.generating ?? generating
  const effectiveGenerateError = generation?.generateError ?? generateError

  useEffect(() => {
    if (!open || base) {
      return
    }
    let stale = false
    void getRuntimeRepoBaseRefDefault(settings, repoId)
      .then((result) => {
        if (!stale && result.defaultBaseRef) {
          setBase(stripBaseRef(result.defaultBaseRef))
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [base, open, repoId, settings])

  useEffect(() => {
    if (!open || baseQuery.trim().length < 2) {
      setBaseResults([])
      setBaseSearchError(null)
      return
    }
    let stale = false
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefs(settings, repoId, baseQuery.trim(), 20)
        .then((results) => {
          if (!stale) {
            setBaseResults(results.map(stripBaseRef))
            setBaseSearchError(null)
          }
        })
        .catch(() => {
          if (!stale) {
            setBaseResults([])
            setBaseSearchError('Branch discovery failed.')
          }
        })
    }, 200)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [baseQuery, open, repoId, settings])

  let generateDisabledReason: string | undefined
  if (submitting) {
    generateDisabledReason = 'Create PR in progress...'
  } else if (!commitMessageAi?.enabled) {
    generateDisabledReason = 'Enable AI commit messages in Settings -> Git.'
  } else if (!effectiveCommitMessageAgentId) {
    generateDisabledReason = 'Pick an agent in Settings -> Git -> AI Commit Messages.'
  } else if (isCustomAgentId(effectiveCommitMessageAgentId)) {
    const command = commitMessageAi.customAgentCommand?.trim() ?? ''
    if (!command) {
      generateDisabledReason =
        'Custom command is empty. Add one in Settings -> Git -> AI Commit Messages.'
    }
  } else if (!base.trim()) {
    generateDisabledReason = 'Choose a base branch before generating.'
  }
  const generateDisabled = !effectiveGenerating && Boolean(generateDisabledReason)

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (!worktreePath || !base.trim() || effectiveGenerating || generateDisabled) {
      return
    }
    if (generation) {
      generation.onGenerate({ base, title, body, draft })
      return
    }
    const requestId = generationRequestIdRef.current + 1
    generationRequestIdRef.current = requestId
    const connectionId = getConnectionId(worktreeId) ?? undefined
    const requestContext = {
      settings: useAppStore.getState().settings,
      worktreeId,
      worktreePath,
      connectionId
    }
    const seed = { requestId, base, title, body, draft, context: requestContext }
    generationSeedRef.current = seed
    generateInFlightRef.current = true
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await generateRuntimePullRequestFields(requestContext, {
        base: stripBaseRef(base.trim()),
        title,
        body,
        draft
      })
      if (result.branchChangedByPreparation) {
        await onBranchChangedByGeneration?.()
      }
      const isCurrentRequest = generationRequestIdRef.current === requestId
      if (!isCurrentRequest) {
        return
      }
      if (!result.success) {
        if (result.canceled) {
          setGenerateError(null)
          return
        }
        setGenerateError(result.error)
        return
      }

      const currentSeed = generationSeedRef.current
      const latestFields = latestFieldsRef.current
      if (
        !currentSeed ||
        currentSeed.requestId !== requestId ||
        currentSeed.base !== latestFields.base ||
        currentSeed.title !== latestFields.title ||
        currentSeed.body !== latestFields.body ||
        currentSeed.draft !== latestFields.draft
      ) {
        setGenerateError('Fields changed while generating. Run generate again for a fresh draft.')
        return
      }
      setBase(stripBaseRef(result.fields.base))
      setBaseQuery('')
      setBaseResults([])
      setTitle(result.fields.title)
      setBody(result.fields.body)
      setDraft(result.fields.draft)
      setGenerateError(null)
    } catch (error) {
      if (generationRequestIdRef.current !== requestId) {
        return
      }
      setGenerateError(
        error instanceof Error ? error.message : 'Failed to generate pull request details'
      )
    } finally {
      if (generationRequestIdRef.current === requestId) {
        generateInFlightRef.current = false
        generationSeedRef.current = null
        setGenerating(false)
      }
    }
  }, [
    base,
    body,
    draft,
    effectiveGenerating,
    generation,
    generateDisabled,
    onBranchChangedByGeneration,
    title,
    worktreeId,
    worktreePath
  ])

  const handleCancelGenerate = useCallback((): void => {
    if (generation) {
      generation.onCancelGenerate()
      return
    }
    const requestContext = generationSeedRef.current?.context
    if (!requestContext?.worktreePath || !generateInFlightRef.current) {
      return
    }
    generationRequestIdRef.current += 1
    generateInFlightRef.current = false
    generationSeedRef.current = null
    setGenerating(false)
    setGenerateError(null)
    void cancelRuntimeGeneratePullRequestFields(requestContext)
  }, [generation])

  return {
    aiGenerationEnabled: commitMessageAi?.enabled === true,
    base,
    setBase,
    title,
    setTitle,
    body,
    setBody,
    draft,
    setDraft,
    baseQuery,
    setBaseQuery,
    baseResults,
    setBaseResults,
    baseSearchError,
    generating: effectiveGenerating,
    generateError: effectiveGenerateError,
    generateDisabled,
    generateDisabledReason,
    handleGenerate,
    handleCancelGenerate
  }
}
