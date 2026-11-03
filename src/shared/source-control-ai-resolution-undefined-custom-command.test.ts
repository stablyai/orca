import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  getDefaultSourceControlAiSettings,
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeRepoSourceControlAiOverrides,
  resolveSourceControlAiForOperation,
  sourceControlAiSettingsFromLegacy
} from './source-control-ai'
import type { CommitMessageAiSettings } from './commit-message-ai-types'
import type { GlobalSettings } from './global-settings-types'
import type { SourceControlAiOperation, SourceControlAiSettings } from './source-control-ai-types'

// Crash report 64553aae (v1.4.200, boundary right-sidebar): the same own-undefined
// customAgentCommand key that crashed the settings pane in 21699b66 also reaches
// resolveSourceControlAiForOperation, whose `source.customAgentCommand.trim()` is the
// Checks panel's prCreationDefaults path. Normalizing at the source covers both.
function settingsWithOwnUndefinedCustomCommand(agentId: 'codex' | 'custom'): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  const sourceControlAi = {
    ...getDefaultSourceControlAiSettings(),
    enabled: true,
    agentId,
    customAgentCommand: undefined
  } as unknown as SourceControlAiSettings
  expect(Object.hasOwn(sourceControlAi, 'customAgentCommand')).toBe(true)
  return { ...base, defaultTuiAgent: 'codex' as const, sourceControlAi }
}

const OPERATIONS: SourceControlAiOperation[] = ['commitMessage', 'pullRequest', 'branchName']

// A repo block of `{}` normalizes to undefined, which is the repo: null case; this one keeps a
// surviving field so the override operand of the customAgentCommand read sees a real object.
const REPO_WITHOUT_CUSTOM_COMMAND = {
  sourceControlAi: { enabled: true, customAgentCommand: '  ' }
}

// A legacy block from a profile that never set a custom command: the key is absent, not empty.
const LEGACY_WITHOUT_CUSTOM_COMMAND = {
  enabled: true,
  agentId: 'custom',
  selectedModelByAgent: {},
  selectedThinkingByModel: {}
} as unknown as CommitMessageAiSettings

describe('resolveSourceControlAiForOperation with an own-undefined customAgentCommand', () => {
  it.each(OPERATIONS)('resolves %s without throwing', (operation) => {
    const settings = settingsWithOwnUndefinedCustomCommand('codex')
    const result = resolveSourceControlAiForOperation({
      settings,
      repo: null,
      operation,
      discoveryHostKey: 'local',
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.params.customAgentCommand : 'unset').toBeUndefined()
    // What the Checks panel useMemo actually reads off the resolved value.
    expect(result.ok ? result.value.prCreationDefaults : null).toEqual(
      DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    )
  })

  // The custom agent is the one case that reads the command for real rather than skipping it.
  it('reports an empty custom command as a normal error, never a TypeError', () => {
    const settings = settingsWithOwnUndefinedCustomCommand('custom')
    const result = resolveSourceControlAiForOperation({
      settings,
      repo: null,
      operation: 'pullRequest',
      discoveryHostKey: 'local',
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    expect(result.ok).toBe(false)
    // Not /command/i: the empty-template and unsupported-agent errors, both returned before the
    // customAgentCommand read, also contain "command" and would pass without it ever running.
    expect(result.ok ? '' : result.error).toMatch(/^Custom command is empty\./)
  })

  it('falls back to the global command when a live repo override supplies none', () => {
    // Without this the fixture can silently normalize away and stop covering the operand.
    expect(
      normalizeRepoSourceControlAiOverrides(REPO_WITHOUT_CUSTOM_COMMAND.sourceControlAi)
    ).toEqual({ enabled: true })
    const result = resolveSourceControlAiForOperation({
      settings: settingsWithOwnUndefinedCustomCommand('custom'),
      repo: REPO_WITHOUT_CUSTOM_COMMAND,
      operation: 'pullRequest',
      discoveryHostKey: 'local',
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/^Custom command is empty\./)
  })

  // Precedence only: the override short-circuits `||`, so this one stays green with the fix
  // reverted and is not itself regression coverage for the crash.
  it('uses the repo override command over the own-undefined global one', () => {
    const result = resolveSourceControlAiForOperation({
      settings: settingsWithOwnUndefinedCustomCommand('custom'),
      repo: {
        sourceControlAi: { customAgentCommand: 'repo-generator {prompt}' }
      },
      operation: 'pullRequest',
      discoveryHostKey: 'local',
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.params.customAgentCommand : '').toBe('repo-generator {prompt}')
  })
})

// No `sourceControlAi` block at all, so the resolver reads the command off its own
// `sourceControlAiSettingsFromLegacy` fallback rather than off a stored block.
describe('resolveSourceControlAiForOperation for a legacy-only profile', () => {
  it('reports an empty custom command instead of throwing', () => {
    const settings = {
      defaultTuiAgent: 'codex' as const,
      agentCmdOverrides: {},
      commitMessageAi: LEGACY_WITHOUT_CUSTOM_COMMAND
    }
    expect(Object.hasOwn(settings, 'sourceControlAi')).toBe(false)
    const result = resolveSourceControlAiForOperation({
      settings,
      repo: null,
      operation: 'pullRequest',
      discoveryHostKey: 'local',
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/^Custom command is empty\./)
  })
})

// The other tests hand-build the broken shape. These take it from the two loader paths that
// produce it, then the structured-clone hop into the renderer store the panel reads. A JSON
// round-trip would drop an own undefined key and hide the whole defect.
const STORED_BLOCK_WITHOUT_CUSTOM_COMMAND: SourceControlAiSettings = {
  ...getDefaultSourceControlAiSettings(),
  agentId: 'custom'
}

const MIGRATED_BLOCKS: [string, () => SourceControlAiSettings][] = [
  [
    'converted from a legacy-only settings.json',
    () => sourceControlAiSettingsFromLegacy(LEGACY_WITHOUT_CUSTOM_COMMAND)
  ],
  // Every production caller of the reconciler passes a stored block; `undefined` takes a branch
  // the loader never reaches, because an absent block is converted above instead.
  [
    'reconciled into a stored block',
    () =>
      mergeLegacyCommitMessageAiIntoSourceControlAi(
        STORED_BLOCK_WITHOUT_CUSTOM_COMMAND,
        LEGACY_WITHOUT_CUSTOM_COMMAND
      )
  ]
]

describe('resolveSourceControlAiForOperation for a migrated legacy profile', () => {
  it.each(MIGRATED_BLOCKS)('survives a block %s', (_label, buildStoredBlock) => {
    const sourceControlAi = structuredClone(buildStoredBlock())
    // Fixture fidelity only: without the key, a reverted fix would read as absence, not undefined.
    expect(Object.hasOwn(sourceControlAi, 'customAgentCommand')).toBe(true)
    const result = resolveSourceControlAiForOperation({
      settings: {
        ...getDefaultSettings('/tmp'),
        defaultTuiAgent: 'codex' as const,
        commitMessageAi: LEGACY_WITHOUT_CUSTOM_COMMAND,
        sourceControlAi
      },
      repo: null,
      operation: 'pullRequest',
      discoveryHostKey: 'local',
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/^Custom command is empty\./)
  })
})
