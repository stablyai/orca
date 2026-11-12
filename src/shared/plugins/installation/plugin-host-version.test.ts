import { describe, expect, it } from 'vitest'
import { satisfiesOrcaEngineRange } from '../manifest/plugin-manifest-engine-range'
import { PLUGIN_THEME_VIDEO_BACKGROUND_SINCE } from '../manifest/plugin-schema-field-docs'
import { PLUGIN_EDITOR_TYPOGRAPHY_SINCE } from '../workers/plugin-host-api-editor-typography'
import { PLUGIN_HOST_API_1_7_SINCE } from '../workers/plugin-host-api-workspace-methods'
import { PLUGIN_HOST_API_1_8_SINCE } from '../workers/plugin-host-api-1-8'
import { PLUGIN_HOST_API_1_9_SINCE } from '../workers/plugin-host-api-1-9'
import { pluginHostVersion } from './plugin-host-version'

describe('pluginHostVersion', () => {
  it('lets a development build run plugins that require what its schemas define', () => {
    const hostVersion = pluginHostVersion('1.4.214')
    for (const since of [
      PLUGIN_THEME_VIDEO_BACKGROUND_SINCE,
      PLUGIN_EDITOR_TYPOGRAPHY_SINCE,
      PLUGIN_HOST_API_1_7_SINCE,
      PLUGIN_HOST_API_1_8_SINCE,
      PLUGIN_HOST_API_1_9_SINCE
    ]) {
      expect(satisfiesOrcaEngineRange(hostVersion, `>=${since}`)).toBe(true)
    }
  })
})
