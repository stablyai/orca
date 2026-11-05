import { defineFixture } from '../../../component-fixtures/component-fixture'
import { pluginTrust } from '../presentation/plugin-access-profile'
import { PluginInstallConsent } from './PluginInstallConsent'

export const binaryFallback = defineFixture({
  width: 560,
  render: () => (
    <PluginInstallConsent
      trust={pluginTrust({ execution: 'sandboxed-ui', points: new Set(['customEditors']) })}
      capabilities={[]}
      shortcuts={[]}
      editorFileTypes={[]}
      editorBinaryFallback
      installed={null}
      official={false}
      publisher="acme"
      changed
      error={null}
    />
  )
})
