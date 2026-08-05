import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HOOK_SOURCE = readFileSync(join(__dirname, 'useComposerState.ts'), 'utf8')
const RECIPE_OPTIONS_SOURCE = readFileSync(
  join(__dirname, 'useEphemeralVmRecipeOptions.ts'),
  'utf8'
)

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('useComposerState launch and automation boundaries', () => {
  it('resolves quick-create base refs through the worktree-create precedence helper', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const smartSubmitBaseBranch',
      'const createDisplayName'
    )

    expect(section).toContain('resolveWorktreeCreateBaseBranch')
    expect(section).toContain('explicitBaseBranch: smartSubmitBaseBranch')
    expect(section).not.toContain('repoWorktreeBaseRef: selectedRepo.worktreeBaseRef')
    expect(section).not.toContain('getRuntimeRepoBaseRefDefault')
  })

  it('plans new workspace agent startup from the selected repo runtime', () => {
    expect(HOOK_SOURCE).toContain('const selectedRepoAgentLaunchPlatform = useMemo')
    expect(HOOK_SOURCE).toContain('getLocalRepoProjectExecutionRuntimeContext')
    expect(HOOK_SOURCE).toContain('getAgentLaunchPlatformForRepo(selectedRepo, projectRuntime)')
    expect(HOOK_SOURCE).toContain(
      'runtimeStatusByEnvironmentId.get(selectedRepoExecutionHost.environmentId)?.status'
    )

    const fullSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submit = useCallback',
      'const submitQuick = useCallback'
    )
    expect(fullSubmit).toContain('platform: selectedRepoAgentLaunchPlatform')
    expect(fullSubmit).not.toContain('platform: CLIENT_PLATFORM')

    const quickSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submitQuick = useCallback',
      'const createGateInput'
    )
    expect(quickSubmit).toContain('platform: selectedRepoAgentLaunchPlatform')
    expect(quickSubmit).not.toContain('platform: CLIENT_PLATFORM')
  })

  it('treats runtime-owned repos as remote when planning agent startup', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const selectedRepoAgentLaunchPlatform',
      'const selectedRepoStartupShell'
    )

    expect(section).toContain("selectedRepoExecutionHost?.kind !== 'local'")
    expect(section).not.toContain('repoIsRemote(selectedRepo)')
  })

  // Why: activation no longer rebuilds a startup from `createdWithAgent`, so this
  // caller's own `startup` is the only thing that launches the agent it planned.
  it('passes its own startup to activation when submit planned an agent', () => {
    const activation = sourceBetween(
      HOOK_SOURCE,
      'const activation = activateAndRevealWorktree(worktree.id, {',
      'if (startupPlan) {'
    )

    expect(activation).toContain('...(startupPlan && !backendSpawnedStartup')
    expect(activation).toContain('command: startupPlan.launchCommand')
    expect(activation).toContain('launchAgent: tuiAgent')
    expect(HOOK_SOURCE).not.toContain('buildCreatedAgentReopenStartup')
  })

  it('prepares linked quick-create drafts for the selected default agent', () => {
    const quickSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submitQuick = useCallback',
      'const createGateInput'
    )

    expect(quickSubmit).toContain(
      'const promptLinkedWorkItem = agent === null ? null : submitLinkedWorkItem'
    )
    expect(quickSubmit).toContain('resolveQuickCreateLinkedWorkItemPrompt(promptLinkedWorkItem')
    expect(quickSubmit).not.toContain('explicitAgentChoice')
    expect(quickSubmit).not.toContain('shouldPrepareQuickLinkedWorkItemAgentPrompt')
    expect(HOOK_SOURCE).not.toContain('resolveQuickWorkspaceSubmitAgent')
  })

  it('keeps sentinel-based Jira and Linear starts out of issue-command templates', () => {
    expect(HOOK_SOURCE).not.toContain('isOrcaCliAvailableForLaunch')
    expect(HOOK_SOURCE).not.toContain('hasGeneratedLinearSourceContext')
    expect(HOOK_SOURCE).not.toContain('shouldDraftGeneratedLinearContext')
    expect(HOOK_SOURCE).toMatch(
      /willApplyIssueCommandAsPrompt[\s\S]*canUseIssueCommandForLinkedItemProvider\(linkedWorkItemProvider\)/
    )

    const previewSection = sourceBetween(
      HOOK_SOURCE,
      'const shouldApplyLinkedOnlyTemplate =',
      'const linkedOnlyTemplatePrompt'
    )
    expect(previewSection).toContain(
      'canUseIssueCommandForLinkedItemProvider(linkedWorkItemProvider)'
    )

    const fullSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submit = useCallback',
      'const submitQuick = useCallback'
    )
    expect(fullSubmit).toContain(
      'canUseIssueCommandForLinkedItemProvider(submitLinkedWorkItemProvider)'
    )
    expect(fullSubmit).toMatch(
      /submitShouldRunIssueAutomation[\s\S]*canUseIssueCommandForLinkedItemProvider\(submitLinkedWorkItemProvider\)/
    )
    expect(fullSubmit).toContain('prompt: submitStartupPrompt')
    expect(fullSubmit).toContain('const shouldSeedInitialAgentStatus =')
    expect(fullSubmit).toContain('...(shouldSeedInitialAgentStatus')

    const quickSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submitQuick = useCallback',
      'const createGateInput'
    )
    expect(quickSubmit).toContain('agent === null || !quickDraftPrompt')
    expect(quickSubmit).toContain('startupPlan.draftPrompt = quickDraftPrompt')
  })

  it('gates per-workspace environment recipe discovery behind the experimental setting', () => {
    const recipeLoadSection = sourceBetween(
      HOOK_SOURCE,
      'const ephemeralVmsEnabled',
      'const selectedRepoConnectionId'
    )
    expect(recipeLoadSection).toContain('settings?.experimentalEphemeralVms === true')
    expect(recipeLoadSection).toContain('useEphemeralVmRecipeOptions')
    expect(recipeLoadSection).toContain('enabled: ephemeralVmsEnabled')
    expect(RECIPE_OPTIONS_SOURCE).toContain('args.enabled &&')
    expect(RECIPE_OPTIONS_SOURCE).toContain('window.api.ephemeralVm')
    expect(RECIPE_OPTIONS_SOURCE).toContain('window.api.plugins.onChanged')
    expect(RECIPE_OPTIONS_SOURCE).toContain('requestGeneration')

    const submitSection = sourceBetween(
      HOOK_SOURCE,
      'let ephemeralVmRecipe',
      'const request: WorktreeCreationRequest'
    )
    expect(submitSection).toContain(
      'const activeEphemeralVmRecipeId = ephemeralVmsEnabled ? selectedEphemeralVmRecipeId : null'
    )
    expect(submitSection).toContain('recipeId: activeEphemeralVmRecipeId')

    const cardPropsSection = sourceBetween(HOOK_SOURCE, 'const cardProps', 'return {')
    expect(cardPropsSection).toContain('ephemeralVmRecipes:')
    expect(cardPropsSection).toContain('!ephemeralVmsEnabled')
    expect(cardPropsSection).toContain('selectedEphemeralVmRecipeId:')
    expect(cardPropsSection).toContain('ephemeralVmRecipeError:')
  })
})
