import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePluginLanguagePackArtifact } from './plugin-language-pack-artifact'

function catalogReplacing(path: string, text: string): Record<string, unknown> {
  return path
    .split('.')
    .reduceRight<Record<string, unknown>>(
      (value, segment, index, segments) => ({
        [segment]: index === segments.length - 1 ? text : value
      }),
      {}
    )
}

const PERMISSION_PILL_CONTROLS = join(
  __dirname,
  '../../../renderer/src/components/native-chat/session/options/controls'
)

/** Every key the composer permission pill and its menu render, read from the source itself. */
function permissionPillKeys(): string[] {
  const keys = new Set<string>()
  for (const file of ['NativeChatPermissionModePicker.tsx', 'native-chat-permission-mode-labels.ts']) {
    const source = readFileSync(join(PERMISSION_PILL_CONTROLS, file), 'utf8')
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
      keys.add(match[1])
    }
  }
  return [...keys].sort()
}

describe('plugin language-pack artifacts', () => {
  it.each([
    'terminal.codexSharedServerBanner.stopServer',
    'terminal.codexSharedServerBanner.alsoStop',
    'terminal.codexSharedServerBanner.dialogSummary',
    'workspaceDeletion.alwaysForceDelete',
    'workspaceDeletion.alwaysForceDeleteDescription',
    'auto.components.sidebar.delete.worktree.flow.2b20ce87b3'
  ])('rejects a language pack replacing destructive copy at %s', (path) => {
    expect(
      parsePluginLanguagePackArtifact(JSON.stringify(catalogReplacing(path, 'Harmless action')))
    ).toEqual({
      ok: false,
      error: `catalog cannot replace protected security copy at ${path}`
    })
  })
  it('finds the permission pill keys it pins', () => {
    expect(permissionPillKeys()).toEqual(
      expect.arrayContaining([
        'components.native-chat.composer.permissionAgentSettings',
        'components.native-chat.composer.permissionFromAgentSettings',
        'components.native-chat.composer.permissionAgentSettingsUsedHint',
        'components.native-chat.composer.permissionAgentSettingsUnnamedHint',
        'components.native-chat.composer.permissionAppliesNextMessage',
        'components.native-chat.composer.pillAccessibleName',
        'components.native-chat.composer.permissionAsk'
      ])
    )
  })
  // The pill says what the running agent may do, so a pack must not be able to reword it.
  it.each(permissionPillKeys())(
    'rejects a language pack relabelling the permission pill at %s',
    (path) => {
      expect(
        parsePluginLanguagePackArtifact(JSON.stringify(catalogReplacing(path, 'Ask for approval')))
      ).toEqual({
        ok: false,
        error: `catalog cannot replace protected security copy at ${path}`
      })
    }
  )
  it('drops protected copy instead of rejecting the pack when loading tolerantly', () => {
    const raw = JSON.stringify({
      common: { save: 'Sávé' },
      components: { 'native-chat': { approval: { allow: 'Álló' }, title: 'Çhát' } }
    })

    expect(parsePluginLanguagePackArtifact(raw).ok).toBe(false)
    expect(parsePluginLanguagePackArtifact(raw, 'tolerant')).toMatchObject({
      ok: true,
      catalog: { common: { save: 'Sávé' }, components: { 'native-chat': { title: 'Çhát' } } }
    })
  })
})
