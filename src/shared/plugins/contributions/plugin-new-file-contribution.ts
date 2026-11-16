import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import {
  pluginFieldDoc,
  pluginPathFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE
} from '../manifest/plugin-schema-field-docs'
import { PLUGIN_ICON_RULE_TEXT } from '../images/plugin-image-fields'
import { pluginFileExtensionSchema } from './plugin-file-match'

export const PLUGIN_NEW_FILE_LIMIT = 16
// Why small: a template seeds an empty document; anything larger belongs in the editor.
export const PLUGIN_NEW_FILE_TEMPLATE_MAX_BYTES = 256 * 1024

export const pluginNewFileContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "New-file id, unique among this plugin's new files. The reserved names `constructor` and `prototype` are refused.",
        PLUGIN_MANIFEST_V2_SINCE,
        ['drawing']
      )
    ),
    title: safePluginDisplayText(z.string().min(1).max(64)).meta(
      pluginFieldDoc(
        'Menu item shown in the tab bar + menu and the command palette.',
        PLUGIN_MANIFEST_V2_SINCE,
        ['New Excalidraw drawing']
      )
    ),
    extension: pluginFileExtensionSchema.meta(
      pluginFieldDoc(
        'Suffix, with the dot, of the untitled file it creates. The file opens in whatever editor takes that suffix, such as a custom editor from this plugin.',
        PLUGIN_MANIFEST_V2_SINCE,
        ['.excalidraw']
      )
    ),
    template: pluginRelativePathSchema
      .optional()
      .meta(
        pluginPathFieldDoc(
          `UTF-8 file copied into the new file, at most ${PLUGIN_NEW_FILE_TEMPLATE_MAX_BYTES / 1024} KB. Without one the file starts empty.`,
          PLUGIN_MANIFEST_V2_SINCE,
          ['templates/empty.excalidraw']
        )
      ),
    icon: pluginRelativePathSchema
      .optional()
      .meta(
        pluginPathFieldDoc(
          `Square image shown beside the menu item. Defaults to the plugin icon. ${PLUGIN_ICON_RULE_TEXT}`,
          PLUGIN_MANIFEST_V2_SINCE,
          ['images/editor-icon.png']
        )
      )
  })
  .strict()
  .meta({
    id: 'NewFileContribution',
    description:
      'A kind of untitled file the user can create from the tab bar + menu or the command palette, in the active workspace.'
  })
