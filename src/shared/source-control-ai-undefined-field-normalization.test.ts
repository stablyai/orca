import { describe, expect, it } from 'vitest'
import type { CommitMessageAiSettings } from './commit-message-ai-types'
import {
  getDefaultSourceControlAiSettings,
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeSourceControlAiSettings,
  sourceControlAiSettingsFromLegacy
} from './source-control-ai'
import type { SourceControlAiSettings } from './source-control-ai-types'

// Crash report 21699b66 (v1.4.199): structured-clone IPC preserves an own key whose value is
// undefined, so such a key used to clobber the default it was spread over and the settings pane
// crashed on `customAgentCommand.trim()`.
function withExplicitUndefined(overrides: Record<string, unknown>): SourceControlAiSettings {
  return { ...getDefaultSourceControlAiSettings(), ...overrides } as SourceControlAiSettings
}

const legacyWithoutOptionalStrings = {
  enabled: true,
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {}
} as unknown as CommitMessageAiSettings

describe('normalizeSourceControlAiSettings with explicit-undefined own keys', () => {
  it('keeps the string defaults instead of adopting undefined', () => {
    const normalized = normalizeSourceControlAiSettings(
      withExplicitUndefined({ customAgentCommand: undefined })
    )
    expect(normalized.customAgentCommand).toBe('')
  })

  it('keeps the other required defaults too', () => {
    const normalized = normalizeSourceControlAiSettings(
      withExplicitUndefined({
        enabled: undefined,
        agentId: undefined,
        selectedModelByAgent: undefined,
        selectedThinkingByModel: undefined,
        instructionsByOperation: undefined,
        actions: undefined,
        prCreationDefaults: undefined
      })
    )
    expect(normalized.enabled).toBe(true)
    expect(normalized.agentId).toBeNull()
    expect(normalized.selectedModelByAgent).toEqual({})
    expect(normalized.selectedThinkingByModel).toEqual({})
    expect(normalized.instructionsByOperation).toEqual({
      commitMessage: '',
      pullRequest: '',
      branchName: ''
    })
    expect(normalized.actions?.commitMessage?.commandInputTemplate).toBeTruthy()
    expect(normalized.prCreationDefaults?.draft).toBe(false)
  })

  it('keeps per-operation instruction strings when one is explicitly undefined', () => {
    const normalized = normalizeSourceControlAiSettings(
      withExplicitUndefined({
        instructionsByOperation: { commitMessage: undefined, pullRequest: 'PR style' }
      })
    )
    expect(normalized.instructionsByOperation.commitMessage).toBe('')
    expect(normalized.instructionsByOperation.pullRequest).toBe('PR style')
  })

  it('never emits an own key holding undefined', () => {
    const normalized = normalizeSourceControlAiSettings(
      withExplicitUndefined({ customAgentCommand: undefined, modelOverridesByOperation: undefined })
    )
    expect(Object.entries(normalized).filter(([, value]) => value === undefined)).toEqual([])
  })
})

describe('legacy commitMessageAi blocks missing keys', () => {
  it('defaults the strings when converting a legacy-only profile', () => {
    const converted = sourceControlAiSettingsFromLegacy(legacyWithoutOptionalStrings)
    expect(converted.customAgentCommand).toBe('')
    expect(converted.instructionsByOperation.commitMessage).toBe('')
  })

  it('reconciles without re-injecting undefined, and stays stable across reloads', () => {
    const first = mergeLegacyCommitMessageAiIntoSourceControlAi(
      undefined,
      legacyWithoutOptionalStrings
    )
    const reloaded = mergeLegacyCommitMessageAiIntoSourceControlAi(
      JSON.parse(JSON.stringify(first)) as SourceControlAiSettings,
      legacyWithoutOptionalStrings
    )
    const reloadedAgain = mergeLegacyCommitMessageAiIntoSourceControlAi(
      JSON.parse(JSON.stringify(reloaded)) as SourceControlAiSettings,
      legacyWithoutOptionalStrings
    )
    expect(first.customAgentCommand).toBe('')
    expect(reloaded.customAgentCommand).toBe('')
    expect(reloadedAgain).toEqual(reloaded)
  })

  // An absent legacy key is absence, not a rollback-build edit: reconciling it must not
  // overwrite what the new-format settings already hold.
  it('keeps a saved customAgentCommand the legacy block never learned about', () => {
    const saved = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      agentId: 'custom',
      customAgentCommand: 'my-generator {prompt}'
    })
    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(saved, {
      ...legacyWithoutOptionalStrings,
      agentId: 'custom'
    })
    expect(merged.customAgentCommand).toBe('my-generator {prompt}')
  })

  it('keeps the saved agentId and its action recipe when the legacy block omits agentId', () => {
    const saved = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      agentId: 'codex'
    })
    const legacyWithoutAgentId = { ...legacyWithoutOptionalStrings } as Record<string, unknown>
    delete legacyWithoutAgentId.agentId
    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(
      saved,
      legacyWithoutAgentId as unknown as CommitMessageAiSettings
    )
    expect(merged.agentId).toBe('codex')
    expect(merged.actions?.commitMessage?.agentId).toBe('codex')
  })

  it('keeps saved commit-message instructions when the legacy block omits customPrompt', () => {
    const saved = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      instructionsByOperation: {
        commitMessage: 'always conventional commits',
        pullRequest: '',
        branchName: ''
      }
    })
    const merged = mergeLegacyCommitMessageAiIntoSourceControlAi(
      saved,
      legacyWithoutOptionalStrings
    )
    expect(merged.instructionsByOperation.commitMessage).toBe('always conventional commits')
  })

  it('keeps Source Control AI switched off when the legacy block omits enabled', () => {
    const saved = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      enabled: false
    })
    const legacyWithoutEnabled = {
      agentId: null,
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customPrompt: '',
      customAgentCommand: ''
    } as unknown as CommitMessageAiSettings
    expect(mergeLegacyCommitMessageAiIntoSourceControlAi(saved, legacyWithoutEnabled).enabled).toBe(
      false
    )
  })
})
