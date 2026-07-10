import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_CONTROL_SOURCE = readFileSync(join(__dirname, 'SourceControl.tsx'), 'utf8')

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
      SOURCE_CONTROL_SOURCE,
      'const handleGeneratePullRequestFieldsForActive = useCallback(',
      'const handleCancelGeneratePullRequestFieldsForActive = useCallback('
    )
    expect(generateSection).toContain('runtimeTargetSettings: activeRepoSettings')
    expect(generateSection).toContain('settings: context.runtimeTargetSettings')

    const cancelSection = sourceBetween(
      SOURCE_CONTROL_SOURCE,
      'const handleCancelGeneratePullRequestFieldsForActive = useCallback(',
      'const {'
    )
    expect(cancelSection).toContain('settings: record.context.runtimeTargetSettings')

    const refreshSection = sourceBetween(
      SOURCE_CONTROL_SOURCE,
      'const refreshGitStatusAfterPullRequestGeneration = useCallback(',
      'useEffect(() => {'
    )
    expect(refreshSection).toContain('settings: context.runtimeTargetSettings')
    expect(refreshSection).not.toContain('settings: activeRepoSettings')
  })

  it('routes create-review field generation through caller-provided owner settings', () => {
    const sourceControlCall = sourceBetween(
      SOURCE_CONTROL_SOURCE,
      '} = useCreatePullRequestDialogFields({',
      'const handleGeneratePullRequestFieldsClick = useCallback'
    )
    expect(sourceControlCall).toContain('settings: activeRepoSettings')

    const hookSource = readFileSync(join(__dirname, 'useCreatePullRequestDialogFields.ts'), 'utf8')
    const requestContext = sourceBetween(hookSource, 'const requestContext = {', 'const seed = {')
    expect(requestContext).toContain('settings,')
    expect(requestContext).not.toContain('useAppStore.getState().settings')
  })
})
