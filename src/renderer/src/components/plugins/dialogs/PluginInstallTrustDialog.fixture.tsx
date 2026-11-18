import { usePluginInstallCountsStore } from '@/store/plugins/installation/plugin-install-counts'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { PluginInstallTrustPrompt } from '../presentation/plugin-install-trust'
import { PluginInstallTrustDialog } from './PluginInstallTrustDialog'

const noop = (): void => {}

const translationPrompt: PluginInstallTrustPrompt = {
  kind: 'translations',
  trustee: 'Ebbop',
  publisher: 'ebbop',
  version: '1.4.261',
  updatedAt: '2026-11-18T00:08:04+01:00',
  installCountPluginKey: 'ebbop.italiano',
  repository: 'github.com/Ebbop/orca-italiano',
  repositoryUrl: 'https://github.com/Ebbop/orca-italiano',
  pluginPageUrl: 'https://orca.dev/plugins/ebbop.italiano?catalog=community',
  location: 'Orca Community Plugins',
  access: []
}

export const communityTranslation = defineFixture({
  width: 560,
  setup: () => {
    usePluginInstallCountsStore.setState({ counts: { 'ebbop.italiano': 1_240 } })
  },
  render: () => (
    <div className="h-[420px]">
      <PluginInstallTrustDialog prompt={translationPrompt} onCancel={noop} onConfirm={noop} />
    </div>
  )
})

export const localFolder = defineFixture({
  width: 560,
  render: () => (
    <div className="h-[340px]">
      <PluginInstallTrustDialog
        prompt={{
          kind: 'local-folder',
          trustee: '/Users/alex/plugins/my-plugin',
          publisher: null,
          repository: null,
          location: '/Users/alex/plugins/my-plugin',
          access: []
        }}
        onCancel={noop}
        onConfirm={noop}
      />
    </div>
  )
})
