import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_SOURCE_QUERY_MAX_BYTES,
  isWorkspaceSourceQueryWithinLimit
} from './workspace-source-query'

describe('workspace source query bound', () => {
  it('measures UTF-8 bytes instead of JavaScript code units', () => {
    expect(isWorkspaceSourceQueryWithinLimit('x'.repeat(WORKSPACE_SOURCE_QUERY_MAX_BYTES))).toBe(
      true
    )
    expect(
      isWorkspaceSourceQueryWithinLimit('é'.repeat(WORKSPACE_SOURCE_QUERY_MAX_BYTES / 2))
    ).toBe(true)
    expect(
      isWorkspaceSourceQueryWithinLimit(`é${'x'.repeat(WORKSPACE_SOURCE_QUERY_MAX_BYTES - 1)}`)
    ).toBe(false)
  })
})
