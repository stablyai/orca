import { getAutoSaveSearchEntry } from './GeneralAutoSaveSetting'
import { GENERAL_SETTING_ANCHORS, generalSetting } from '../general/general-setting-anchors'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { getVisibleEditorTypographySearchDescriptors } from './editor-typography-search'
import { getFormatOnSaveSearchEntry } from './EditorFormatOnSaveSetting'
import { getInsertFinalNewlineSearchEntry } from './EditorInsertFinalNewlineSetting'
import { getGitChangeGutterSearchEntry } from './EditorGitChangeGutterSetting'

export const getGeneralEditorSearchDescriptors = createLocalizedCatalog(() => [
  generalSetting(GENERAL_SETTING_ANCHORS.formatOnSave, getFormatOnSaveSearchEntry()),
  generalSetting(GENERAL_SETTING_ANCHORS.finalNewline, getInsertFinalNewlineSearchEntry()),
  generalSetting(GENERAL_SETTING_ANCHORS.autoSave, getAutoSaveSearchEntry()),
  generalSetting(GENERAL_SETTING_ANCHORS.autoSaveDelay, {
    title: translate('auto.components.settings.general.search.d9168badd2', 'Auto save delay'),
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
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.fontFamily, {
    title: translate('auto.components.settings.general.search.66395fb7ff', 'Editor font family'),
    description: translate(
      'auto.components.settings.general.search.editorFontFamilyDesc',
      'Font used by file editors and diff views, and by Markdown code when set. Leave empty to follow the terminal font.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.e1ee631696', 'editor'),
      ...translateSearchKeyword('auto.components.settings.general.search.editorFontKw', 'font'),
      ...translateSearchKeyword('auto.components.settings.general.search.3ca5ab78a5', 'code')
    ]
  }),
  ...getVisibleEditorTypographySearchDescriptors(),
  generalSetting(GENERAL_SETTING_ANCHORS.editorWrap, {
    title: translate('auto.components.settings.general.search.e2947b3723', 'Editor word wrap'),
    description: translate(
      'auto.components.settings.general.search.005be5c699',
      'Wrap long lines in file editors instead of requiring horizontal scrolling.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.e1ee631696', 'editor'),
      ...translateSearchKeyword('auto.components.settings.general.search.3ca5ab78a5', 'code')
    ]
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.collapseUnchanged, {
    title: translate(
      'auto.components.settings.general.search.aa367d753d',
      'Collapse unchanged regions'
    ),
    description: translate(
      'auto.components.settings.general.search.collapseUnchangedDesc',
      'Show only changed lines and a little surrounding context in a file diff, hiding the rest behind expandable bands. The View All Changes diff always collapses this way.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.3b5733573e', 'diff'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.collapseUnchangedKw',
        'collapse'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.hideUnchangedKw',
        'hide unchanged'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.foldKw', 'fold')
    ]
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.diffView, {
    title: translate('auto.components.settings.general.search.aa1c06eb2c', 'Default diff view'),
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
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.diffTree, {
    title: translate(
      'auto.components.settings.general.search.b8e1e1ac68',
      'Default diff file tree'
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
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.minimap, {
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
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.gitChangeGutter, getGitChangeGutterSearchEntry()),
  generalSetting(GENERAL_SETTING_ANCHORS.markdownView, {
    title: translate('auto.components.settings.general.search.0f9304f821', 'Default Markdown view'),
    description: translate(
      'auto.components.settings.general.search.markdownDefaultViewDesc',
      'The view Markdown files open in. Right-click the view switcher in a Markdown tab to change it there.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.d05f629d2c', 'markdown'),
      ...translateSearchKeyword('auto.components.settings.general.search.2b463f0bf9', 'view'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.markdownSourceKw',
        'source'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.markdownRichKw', 'rich')
    ]
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.spellcheck, {
    title: translate(
      'auto.components.settings.general.search.8ad175042b',
      'Rich Markdown spellcheck'
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
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.reviewNotes, {
    title: translate('auto.components.settings.general.search.728a309ce1', 'Markdown review notes'),
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
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.diffWhitespace, {
    title: translate(
      'auto.components.settings.GeneralEditorSettingsSection.0971ef5c63',
      'Diff show whitespace'
    ),
    description: translate(
      'auto.components.settings.GeneralEditorSettingsSection.94a479cef3',
      'Show leading and trailing whitespace differences in diffs.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.diff', 'diff'),
      ...translateSearchKeyword('settings.general.search.keywords.whitespace', 'whitespace'),
      ...translateSearchKeyword('settings.general.search.keywords.spaces', 'spaces'),
      ...translateSearchKeyword('settings.general.search.keywords.tabs', 'tabs'),
      ...translateSearchKeyword('settings.general.search.keywords.trim', 'trim'),
      ...translateSearchKeyword('settings.general.search.keywords.indentation', 'indentation')
    ]
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.diffWrap, {
    title: translate(
      'auto.components.settings.GeneralEditorSettingsSection.6f33c2a32f',
      'Diff word wrap'
    ),
    description: translate(
      'auto.components.settings.GeneralEditorSettingsSection.4aa4d9fb73',
      'Wrap long lines in diff editors instead of requiring horizontal scrolling.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.diff', 'diff'),
      ...translateSearchKeyword('settings.general.search.keywords.word_wrap', 'word wrap'),
      ...translateSearchKeyword('settings.general.search.keywords.wrap', 'wrap'),
      ...translateSearchKeyword('settings.general.search.keywords.markdown', 'markdown'),
      ...translateSearchKeyword('settings.general.search.keywords.long_lines', 'long lines')
    ]
  })
])

export const getGeneralEditorSearchEntries = createLocalizedCatalog(() =>
  getGeneralEditorSearchDescriptors().map(({ entry }) => entry)
)
