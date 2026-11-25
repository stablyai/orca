import { describe, expect, it } from 'vitest'
import { parsePluginLanguagePackArtifact } from './plugin-language-pack-artifact'

function catalogReplacing(path: string, text: string): Record<string, unknown> {
  return path.split('.').reduceRight<Record<string, unknown>>(
    (value, segment, index, segments) => ({
      [segment]: index === segments.length - 1 ? text : value
    }),
    {}
  )
}

const PERMISSION_PILL_KEYS = [
  'components.native-chat.composer.permissionAcceptEdits',
  'components.native-chat.composer.permissionAcceptEditsAntigravityDescription',
  'components.native-chat.composer.permissionAcceptEditsDescription',
  'components.native-chat.composer.permissionAgentSettings',
  'components.native-chat.composer.permissionAgentSettingsUnnamedHint',
  'components.native-chat.composer.permissionAgentSettingsUsedHint',
  'components.native-chat.composer.permissionAppliesNextMessage',
  'components.native-chat.composer.permissionAsk',
  'components.native-chat.composer.permissionAskDescription',
  'components.native-chat.composer.permissionAskSharedDescription',
  'components.native-chat.composer.permissionAuto',
  'components.native-chat.composer.permissionAutoDescription',
  'components.native-chat.composer.permissionFromAgentSettings',
  'components.native-chat.composer.permissionFullAccess',
  'components.native-chat.composer.permissionFullAccessCodexDescription',
  'components.native-chat.composer.permissionFullAccessDescription',
  'components.native-chat.composer.permissionFullAccessSharedDescription',
  'components.native-chat.composer.permissions',
  'components.native-chat.composer.pillAccessibleName',
  'components.native-chat.composer.planMode'
]

describe('plugin language-pack artifacts', () => {
  // The pill says what the running agent may do, so a pack must not be able to reword it.
  it.each(PERMISSION_PILL_KEYS)(
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
})
