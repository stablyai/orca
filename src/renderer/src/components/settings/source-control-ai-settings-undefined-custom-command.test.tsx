// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CommitMessageAiSettings } from '../../../../shared/commit-message-ai-types'
import {
  getDefaultSourceControlAiSettings,
  mergeLegacyCommitMessageAiIntoSourceControlAi
} from '../../../../shared/source-control-ai'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import { CommitMessageAiPane } from './CommitMessageAiPane'

// Crash report 21699b66 (v1.4.199, boundary page.settings): a settings.json whose legacy
// `commitMessageAi` block has no `customAgentCommand` key — the shape JSON.stringify leaves
// behind once the field has been undefined once.
const legacyWithoutCustomAgentCommand = {
  enabled: true,
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {},
  customPrompt: ''
} as unknown as CommitMessageAiSettings

function reloadFromDisk(sourceControlAi: SourceControlAiSettings): SourceControlAiSettings {
  return mergeLegacyCommitMessageAiIntoSourceControlAi(
    JSON.parse(JSON.stringify(sourceControlAi)) as SourceControlAiSettings,
    legacyWithoutCustomAgentCommand
  )
}

function renderPane(sourceControlAi: SourceControlAiSettings): () => string {
  const settings = {
    ...getDefaultSettings('/tmp'),
    commitMessageAi: legacyWithoutCustomAgentCommand,
    sourceControlAi
  }
  return () =>
    renderToStaticMarkup(
      <CommitMessageAiPane settings={settings} updateSettings={() => {}} settingsSearchQuery="" />
    )
}

describe('Source Control AI pane with no persisted customAgentCommand', () => {
  it('keeps customAgentCommand a string when the legacy block omits it', () => {
    const migrated = mergeLegacyCommitMessageAiIntoSourceControlAi(
      undefined,
      legacyWithoutCustomAgentCommand
    )
    const loaded = reloadFromDisk(migrated)
    expect(Object.hasOwn(loaded, 'customAgentCommand')).toBe(true)
    expect(typeof loaded.customAgentCommand).toBe('string')
  })

  it('renders the pane instead of throwing the page.settings boundary TypeError', () => {
    const migrated = mergeLegacyCommitMessageAiIntoSourceControlAi(
      undefined,
      legacyWithoutCustomAgentCommand
    )
    expect(renderPane(reloadFromDisk(migrated))).not.toThrow()
  })

  // Structured-clone IPC, unlike JSON, hands the renderer an own key holding undefined, so the
  // pane must survive that shape even when it never goes back through the legacy reconciliation.
  it('renders the pane when main sends an own customAgentCommand key holding undefined', () => {
    const cloned = { ...getDefaultSourceControlAiSettings(), customAgentCommand: undefined }
    expect(renderPane(cloned as unknown as SourceControlAiSettings)).not.toThrow()
  })
})
