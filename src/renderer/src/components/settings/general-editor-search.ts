import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getGeneralEditorSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.ae21e806ce', 'Auto Save Files'),
    description: translate(
      'auto.components.settings.general.search.e9d948d3c3',
      'Save editor and editable diff changes automatically after a short pause.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.86f54575c7', 'autosave'),
      translate('auto.components.settings.general.search.4469b6fa4e', 'save')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.14e46c745b', 'Auto Save Delay'),
    description: translate(
      'auto.components.settings.general.search.8ea61ad55c',
      'How long Orca waits after your last edit before saving automatically.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.86f54575c7', 'autosave'),
      translate('auto.components.settings.general.search.146728ac2c', 'delay'),
      translate('auto.components.settings.general.search.b2799ba622', 'milliseconds')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.2760c9933f', 'Default Diff View'),
    description: translate(
      'auto.components.settings.general.search.ecb9415c80',
      'Preferred presentation format for showing git diffs by default.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.3b5733573e', 'diff'),
      translate('auto.components.settings.general.search.2b463f0bf9', 'view'),
      translate('auto.components.settings.general.search.0a5fa65926', 'inline'),
      translate('auto.components.settings.general.search.233f7e2f37', 'side-by-side'),
      translate('auto.components.settings.general.search.be24c7cd67', 'split')
    ]
  },
  {
    title: translate(
      'auto.components.settings.general.search.adec13f2ef',
      'Default Diff File Tree'
    ),
    description: translate(
      'auto.components.settings.general.search.dec71988f0',
      'Show or hide the file tree when opening combined diff views.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.3b5733573e', 'diff'),
      translate('auto.components.settings.general.search.2f42852568', 'tree'),
      translate('auto.components.settings.general.search.0a02059549', 'file tree'),
      translate('auto.components.settings.general.search.973ed6bfbf', 'combined diff'),
      translate('auto.components.settings.general.search.19baae651b', 'sidebar')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.6f584fcb48', 'Minimap'),
    description: translate(
      'auto.components.settings.general.search.716a4dfb1f',
      'Show the minimap overview when editing a file.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.9c72990db8', 'minimap'),
      translate('auto.components.settings.general.search.e3919429c0', 'overview'),
      translate('auto.components.settings.general.search.3ca5ab78a5', 'code'),
      translate('auto.components.settings.general.search.a0014961ae', 'scroll')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.128bc09325', 'Markdown Review Notes'),
    description: translate(
      'auto.components.settings.general.search.694613d47f',
      'Show local markdown review note controls in rich editor mode.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.d05f629d2c', 'markdown'),
      translate('auto.components.settings.general.search.4dd5684836', 'review'),
      translate('auto.components.settings.general.search.1ff67ba40c', 'notes'),
      translate('auto.components.settings.general.search.22572e99c1', 'annotations'),
      translate('auto.components.settings.general.search.baa263d6d8', 'agents')
    ]
  }
])
