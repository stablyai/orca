import { defineFixture } from '../../../component-fixtures/component-fixture'
import { pluginTrust } from '../presentation/plugin-access-profile'
import { PluginInstallConsent } from './PluginInstallConsent'

const consent = {
  trust: pluginTrust({ execution: 'sandboxed-ui', points: new Set(['customEditors']) }),
  capabilities: [],
  shortcuts: [],
  editorFileTypes: ['.bin'],
  installed: null,
  official: false,
  publisher: 'acme',
  changed: true,
  error: null
}

export const extensionOnly = defineFixture({
  width: 560,
  render: () => <PluginInstallConsent {...consent} />
})

export const binaryFallback = defineFixture({
  width: 560,
  render: () => <PluginInstallConsent {...consent} editorBinaryFallback />
})
