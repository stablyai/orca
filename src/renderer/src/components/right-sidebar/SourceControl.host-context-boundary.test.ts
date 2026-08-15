import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKTREE_CONTEXT_SOURCE = readFileSync(
  join(__dirname, 'source-control/listing/use-worktree-context.ts'),
  'utf8'
)
const PR_GENERATION_SOURCE = readFileSync(
  join(__dirname, 'source-control/review/use-pull-request-generation.ts'),
  'utf8'
)
const CREATE_REVIEW_COMPOSER_SOURCE = readFileSync(
  join(__dirname, 'source-control/review/use-create-review-composer.ts'),
  'utf8'
)
const STATUS_REFRESH_SOURCE = readFileSync(
  join(__dirname, 'source-control/sync/use-status-refresh.ts'),
  'utf8'
)
const BASE_REF_DEFAULT_SOURCE = readFileSync(
  join(__dirname, 'source-control/sync/use-base-ref-default.ts'),
  'utf8'
)

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('SourceControl host-context boundaries', () => {
  it('snapshots PR generation host ownership and reuses it after async branch preparation', () => {
    const generateSection = sourceBetween(
      PR_GENERATION_SOURCE,
      'const handleGeneratePullRequestFieldsForActive = useCallback(',
      'const handleCancelGeneratePullRequestFieldsForActive = useCallback('
    )
    expect(generateSection).toContain('runtimeTargetSettings: activeRepoSettings')
    expect(generateSection).toContain('settings: context.runtimeTargetSettings')

    const cancelSection = sourceBetween(
      PR_GENERATION_SOURCE,
      'const handleCancelGeneratePullRequestFieldsForActive = useCallback(',
      'const handlePullRequestGenerationSeedRestored = useCallback('
    )
    expect(cancelSection).toContain('settings: record.context.runtimeTargetSettings')

    const refreshSection = sourceBetween(
      STATUS_REFRESH_SOURCE,
      'const refreshGitStatusAfterPullRequestGeneration = useCallback(',
      '  return {'
    )
    expect(refreshSection).toContain('settings: context.runtimeTargetSettings')
    expect(refreshSection).not.toContain('settings: activeRepoSettings')
  })

  it('routes create-review field generation through caller-provided owner settings', () => {
    const composerCall = sourceBetween(
      CREATE_REVIEW_COMPOSER_SOURCE,
      '} = useCreatePullRequestDialogFields({',
      'const handleGeneratePullRequestFieldsClick = useCallback'
    )
    expect(composerCall).toContain('settings: activeRepoSettings')

    const hookSource = readFileSync(
      join(__dirname, 'use-create-pull-request-field-generation.ts'),
      'utf8'
    )
    const requestContext = sourceBetween(hookSource, 'const requestContext = {', 'const seed = {')
    expect(requestContext).toContain('settings,')
    expect(requestContext).not.toContain('useAppStore.getState().settings')
  })

  it('keeps eligibility base refreshes scoped to repo execution ownership', () => {
    const ownerSettingsSection = sourceBetween(
      WORKTREE_CONTEXT_SOURCE,
      'const activeRepoSettings = useMemo(',
      'const activeRepoRuntimeEnvironmentId'
    )
    expect(ownerSettingsSection).not.toContain('activeRepo ?? null')
    expect(ownerSettingsSection).toContain(
      '[activeRepoConnectionId, activeRepoExecutionHostId, activeRepoId, settings]'
    )

    const baseRefSection = sourceBetween(
      BASE_REF_DEFAULT_SOURCE,
      '// Why: reset to null so that effectiveBaseRef becomes falsy until the IPC',
      '  return defaultBaseRef'
    )
    expect(baseRefSection).toContain(
      'getRuntimeRepoBaseRefDefault(\n      { activeRuntimeEnvironmentId: activeRepoRuntimeEnvironmentId },\n      activeRepoId'
    )
    const dependencyBlock = sourceBetween(baseRefSection, '  }, [', '  ])')
    const dependencyEntries = dependencyBlock
      .split('\n')
      .slice(1)
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => line.length > 0 && !line.startsWith('//'))
    expect(dependencyEntries).toEqual([
      'activeRepoConnectionId',
      'activeRepoExecutionHostId',
      'activeRepoId',
      'activeRepoRuntimeEnvironmentId',
      'isBranchVisible',
      'isFolder'
    ])
  })
})
