import type { AppState } from '../types'
import {
  getLocalAgentPreflightContext,
  localPreflightContextKey,
  type LocalPreflightContext
} from '@/lib/local-preflight-context'
import type { LocalDetectedAgentInput } from './local-detected-agent-store-state'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

export type LocalAgentDetectionContext = {
  context: LocalPreflightContext
  contextKey: string
  explicitContext: NonNullable<LocalPreflightContext> | undefined
  isFloating: boolean
  shouldExposeToLegacy: boolean
}

export function getLocalAgentDetectionContext(
  state: AppState,
  input?: LocalDetectedAgentInput
): LocalAgentDetectionContext {
  const explicitContext = typeof input === 'object' && input !== null ? input : undefined
  const worktreeId = typeof input === 'string' || input === null ? input : undefined
  const isFloating = worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  const shouldExposeToLegacy = !explicitContext && !isFloating
  const context =
    explicitContext ?? getLocalAgentPreflightContext(state, undefined, undefined, worktreeId)
  return {
    context,
    contextKey: localPreflightContextKey(context),
    explicitContext,
    isFloating,
    shouldExposeToLegacy
  }
}
