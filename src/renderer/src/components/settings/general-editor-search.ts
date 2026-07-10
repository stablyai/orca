import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getGeneralEditorSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.ae21e806ce', 'Auto Save Files'),
    description: translate(
      'auto.components.settings.general.search.e9d948d3c3',
      'Save editor and editable diff changes automatically after a short pause.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.86f54575c7', 'autosave'),
      ...translateSearchKeyword('auto.components.settings.general.search.4469b6fa4e', 'save')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.14e46c745b', 'Auto Save Delay'),
    description: translate(
      'auto.components.settings.general.search.8ea61ad55c',
      'How long Orca waits after your last edit before saving automatically.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.86f54575c7', 'autosave'),
      ...translateSearchKeyword('auto.components.settings.general.search.146728ac2c', 'delay'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.b2799ba622',
        'milliseconds'
      )
    ]
  },
  {
    title: translate('auto.components.settings.general.search.2760c9933f', 'Default Diff View'),
    description: translate(
      'auto.components.settings.general.search.ecb9415c80',
      'Preferred presentation format for showing git diffs by default.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.3b5733573e', 'diff'),
      ...translateSearchKeyword('auto.components.settings.general.search.2b463f0bf9', 'view'),
      ...translateSearchKeyword('auto.components.settings.general.search.0a5fa65926', 'inline'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.233f7e2f37',
        'side-by-side'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.be24c7cd67', 'split')
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
      ...translateSearchKeyword('auto.components.settings.general.search.3b5733573e', 'diff'),
      ...translateSearchKeyword('auto.components.settings.general.search.2f42852568', 'tree'),
      ...translateSearchKeyword('auto.components.settings.general.search.0a02059549', 'file tree'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.973ed6bfbf',
        'combined diff'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.19baae651b', 'sidebar')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.6f584fcb48', 'Minimap'),
    description: translate(
      'auto.components.settings.general.search.716a4dfb1f',
      'Show the minimap overview when editing a file.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.9c72990db8', 'minimap'),
      ...translateSearchKeyword('auto.components.settings.general.search.e3919429c0', 'overview'),
      ...translateSearchKeyword('auto.components.settings.general.search.3ca5ab78a5', 'code'),
      ...translateSearchKeyword('auto.components.settings.general.search.a0014961ae', 'scroll')
    ]
  },
  {
    title: translate(
      'auto.components.settings.general.search.d2d2d929c0',
      'Rich Markdown Spellcheck'
    ),
    description: translate(
      'auto.components.settings.general.search.4497e2e2bb',
      'Show browser spelling underlines and suggestions while editing rich Markdown.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.f96cdaf37d', 'spellcheck'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.a51d23f4a1',
        'spell check'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.641358460a', 'spelling'),
      ...translateSearchKeyword('auto.components.settings.general.search.d05f629d2c', 'markdown'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.d755962089',
        'red underline'
      )
    ]
  },
  {
    title: translate('auto.components.settings.general.search.128bc09325', 'Markdown Review Notes'),
    description: translate(
      'auto.components.settings.general.search.694613d47f',
      'Show local markdown review note controls in rich editor mode.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.d05f629d2c', 'markdown'),
      ...translateSearchKeyword('auto.components.settings.general.search.4dd5684836', 'review'),
      ...translateSearchKeyword('auto.components.settings.general.search.1ff67ba40c', 'notes'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.22572e99c1',
        'annotations'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.baa263d6d8', 'agents')
    ]
  }
])
