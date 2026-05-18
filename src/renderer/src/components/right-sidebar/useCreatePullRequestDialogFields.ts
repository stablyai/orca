import { useCallback, useEffect, useRef, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore, type AppState } from '@/store'
import {
  cancelRuntimeGeneratePullRequestFields,
  generateRuntimePullRequestFields
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
}

type GenerationSeed = {
  requestId: number
  base: string
  title: string
  body: string
  draft: boolean
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
  submitting
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

  useEffect(() => {
    latestFieldsRef.current = { base, title, body, draft }
  }, [base, body, draft, title])

  useEffect(() => {
    if (!open) {
      generationRequestIdRef.current += 1
      if (generateInFlightRef.current && worktreePath) {
        const connectionId = getConnectionId(worktreeId) ?? undefined
        void cancelRuntimeGeneratePullRequestFields({
          settings,
          worktreeId,
          worktreePath,
          connectionId
        })
      }
      generateInFlightRef.current = false
      generationSeedRef.current = null
      initializedFromEligibilityRef.current = null
      setGenerating(false)
      setGenerateError(null)
      return
    }
    if (!eligibility) {
      return
    }
    const initializationKey = `${repoId}:${branch}`
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
  }, [branch, eligibility, open, repoId, settings, worktreeId, worktreePath])

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
  const generateDisabled = !generating && Boolean(generateDisabledReason)

  const handleGenerate = useCallback(async (): Promise<void> => {
    if (!worktreePath || !base.trim() || generateInFlightRef.current || generateDisabled) {
      return
    }
    const requestId = generationRequestIdRef.current + 1
    generationRequestIdRef.current = requestId
    const seed = { requestId, base, title, body, draft }
    generationSeedRef.current = seed
    generateInFlightRef.current = true
    setGenerating(true)
    setGenerateError(null)
    try {
      const connectionId = getConnectionId(worktreeId) ?? undefined
      const result = await generateRuntimePullRequestFields(
        {
          settings: useAppStore.getState().settings,
          worktreeId,
          worktreePath,
          connectionId
        },
        {
          base: stripBaseRef(base.trim()),
          title,
          body,
          draft
        }
      )
      if (generationRequestIdRef.current !== requestId) {
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
  }, [base, body, draft, generateDisabled, title, worktreeId, worktreePath])

  const handleCancelGenerate = useCallback((): void => {
    if (!worktreePath || !generateInFlightRef.current) {
      return
    }
    generationRequestIdRef.current += 1
    generateInFlightRef.current = false
    generationSeedRef.current = null
    setGenerating(false)
    setGenerateError(null)
    const connectionId = getConnectionId(worktreeId) ?? undefined
    void cancelRuntimeGeneratePullRequestFields({
      settings: useAppStore.getState().settings,
      worktreeId,
      worktreePath,
      connectionId
    })
  }, [worktreeId, worktreePath])

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
    generating,
    generateError,
    generateDisabled,
    generateDisabledReason,
    handleGenerate,
    handleCancelGenerate
  }
}
