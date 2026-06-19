import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FIELD_SOURCE = readFileSync(
  join(__dirname, 'SmartWorkspaceNameField.tsx'),
  'utf8'
).replaceAll('\r\n', '\n')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('SmartWorkspaceNameField repo-backed source boundaries', () => {
  it('resets hidden repo-backed modes and stale results when source lookup is disabled', () => {
    const modeResetSection = sourceBetween(
      FIELD_SOURCE,
      'useEffect(() => {\n    if (availableModes.some((item) => item.id === mode))',
      'const selectedSourceFocusKey'
    )

    expect(modeResetSection).toContain("setMode(availableModes[0]?.id ?? 'text')")
    expect(modeResetSection).toContain('repoBackedSourcesDisabled')
    expect(modeResetSection).toContain('setGithubItems([])')
    expect(modeResetSection).toContain('setGitlabItems([])')
    expect(modeResetSection).toContain('setBranches([])')
    expect(modeResetSection).toContain('setCrossRepoPrompt(null)')

    const availableModesSection = sourceBetween(
      FIELD_SOURCE,
      'const availableModes = getSmartWorkspaceNameModes().filter',
      'const mrStateFilters = getMrStateFilters()'
    )
    expect(availableModesSection).toContain('return !repoBackedSourcesDisabled')
    expect(availableModesSection).toContain('return gitlabSourceAvailable')
    expect(availableModesSection).toContain('branchesEnabled && !repoBackedSourcesDisabled')
    expect(FIELD_SOURCE).toContain('repoBackedSourcesDisabled')
    expect(FIELD_SOURCE).toContain('!textOnly &&\n    gitlabSourceAvailable')

    const placeholderSection = sourceBetween(
      FIELD_SOURCE,
      'const smartPlaceholder = repoBackedSourcesDisabled',
      'return ('
    )
    expect(placeholderSection).toContain('Type a name or Linear URL')
    expect(placeholderSection).toContain('Type a workspace name')
    expect(placeholderSection).toContain('Type a name, #1234, branch, GitHub/GitLab or Linear URL')
    expect(placeholderSection).toContain('Search GitLab MRs and issues')
  })

  it('can hide the global add-project cross-repo action for subordinate task sources', () => {
    expect(FIELD_SOURCE).toContain('allowCrossRepoProjectAdd?: boolean')
    expect(FIELD_SOURCE).toContain('allowCrossRepoProjectAdd = true')
    expect(FIELD_SOURCE).toContain('!crossRepoPrompt || !allowCrossRepoProjectAdd')
    expect(FIELD_SOURCE).toContain(') : allowCrossRepoProjectAdd ? (')
  })

  it('searches repo-backed task sources through implicit repo targets instead of a menu', () => {
    expect(FIELD_SOURCE).not.toContain('RepoBackedSourceMenu')
    expect(FIELD_SOURCE).not.toContain('repoBackedSourceOptions')
    expect(FIELD_SOURCE).toContain('repoBackedSearchRepos?: readonly RepoOption[]')

    const targetSection = sourceBetween(
      FIELD_SOURCE,
      'const repoBackedSearchTargets = useMemo',
      'const linearSourceContext = useMemo'
    )

    expect(targetSection).toContain('repoBackedSearchRepos.length > 0')
    expect(targetSection).toContain('githubSourceContext')
    expect(targetSection).toContain('gitlabSourceContext')

    const githubLookupSection = sourceBetween(
      FIELD_SOURCE,
      'const shouldQueryGithub =',
      'const branchSearchRequest = useMemo'
    )
    expect(githubLookupSection).toContain('repoBackedSearchTargets.length > 0')
    expect(githubLookupSection).toContain('fetchWorkItemsAcrossRepos')
    expect(githubLookupSection).toContain('repoBackedSearchTargets.map')
  })

  it('reports the active source mode without lifting source search state', () => {
    expect(FIELD_SOURCE).toContain('onActiveSourceModeChange?: (mode: SmartNameMode) => void')
    expect(FIELD_SOURCE).toContain('onActiveSourceModeChange')
    expect(FIELD_SOURCE).toContain('onActiveSourceModeChange?.(mode)')
    expect(FIELD_SOURCE).toContain('[mode, onActiveSourceModeChange]')
  })

  it('defers the source popover until composer interaction', () => {
    expect(FIELD_SOURCE).toContain('deferSourcePopoverUntilInteractionRef')
    expect(FIELD_SOURCE).toContain('handleSourcePopoverOpenChange')
    expect(FIELD_SOURCE).toContain('isComposerFieldToFieldFocus')
    expect(FIELD_SOURCE).toContain('onPointerDown={() => {')
    expect(FIELD_SOURCE).toContain('markSourcePopoverUserEngaged()')
  })
})
