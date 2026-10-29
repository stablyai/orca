import { useLayoutEffect, type RefObject } from 'react'
import {
  observeStructuredPermissionReport,
  structuredPermissionPickStands,
  type StructuredOptionPickBook
} from '../../../../shared/structured-agent-session-option-pick-book'
import { projectRuntimePermission } from '../../../../shared/structured-agent-session-permission-option'

/** The running agent's mode report, with a pick it hasn't taken yet standing in until it reports again. */
export function useRuntimePermissionProjection(
  summary: unknown,
  fence: number | null,
  optionPicks: RefObject<StructuredOptionPickBook>
) {
  useLayoutEffect(() => {
    observeStructuredPermissionReport(optionPicks.current, summary, fence)
  }, [optionPicks, summary, fence])
  return <T extends { reportedPermissionMode?: string | null; permissionMode?: string | null }>(
    state: T
  ): T =>
    projectRuntimePermission(
      state,
      summary,
      fence,
      structuredPermissionPickStands(optionPicks.current, summary, fence)
    )
}
