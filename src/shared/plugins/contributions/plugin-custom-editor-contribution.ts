import { z } from 'zod'
import { pluginIdSchema, pluginRelativePathSchema } from '../manifest/plugin-manifest-fields'
import {
  pluginFieldDoc,
  pluginPathFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE
} from '../manifest/plugin-schema-field-docs'
import { pluginFileMatchFields } from './plugin-file-match'
import { PLUGIN_ICON_RULE_TEXT } from '../images/plugin-image-fields'

export const PLUGIN_CUSTOM_EDITOR_LIMIT = 16

export const PLUGIN_CUSTOM_EDITOR_PRIORITIES = ['default', 'option'] as const

/** What the editor frame receives: the file's text, or its raw bytes. */
export const PLUGIN_CUSTOM_EDITOR_CONTENT_KINDS = ['text', 'bytes'] as const
export type PluginCustomEditorContentKind = (typeof PLUGIN_CUSTOM_EDITOR_CONTENT_KINDS)[number]

export const pluginCustomEditorContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "Editor id, unique among this plugin's custom editors. The reserved names `constructor` and `prototype` are refused.",
        PLUGIN_MANIFEST_V2_SINCE,
        ['excalidraw']
      )
    ),
    title: z
      .string()
      .min(1)
      .max(64)
      .meta(
        pluginFieldDoc(
          "Name shown in the editor's view toggle beside Source, and on the tab of a file it opens.",
          PLUGIN_MANIFEST_V2_SINCE,
          ['Excalidraw']
        )
      ),
    icon: pluginRelativePathSchema
      .optional()
      .meta(
        pluginPathFieldDoc(
          `Square image shown on the tab of a file this editor opens. Defaults to the plugin icon. ${PLUGIN_ICON_RULE_TEXT}`,
          PLUGIN_MANIFEST_V2_SINCE,
          ['images/editor-icon.png']
        )
      ),
    ...pluginFileMatchFields('this editor', PLUGIN_MANIFEST_V2_SINCE, {
      extensions: ['.excalidraw', '.excalidraw.json'],
      filenames: []
    }),
    entry: pluginRelativePathSchema.meta(
      pluginPathFieldDoc(
        'HTML file rendered inside an editor frame, like a panel. It receives the open document and posts edits back; it never gets a file path or file system. It is trusted code: install editors you trust.',
        PLUGIN_MANIFEST_V2_SINCE,
        ['editor/index.html']
      )
    ),
    priority: z
      .enum(PLUGIN_CUSTOM_EDITOR_PRIORITIES)
      .optional()
      .meta(
        pluginFieldDoc(
          '`default` (the default) opens matching files in this editor; `option` only offers it in the view toggle, so files open in Source. Files Orca opens itself (such as `.json`, `.ts`, `.md`, `.csv`, `.yaml`, lockfiles and `.env` files) always behave as `option`.',
          PLUGIN_MANIFEST_V2_SINCE,
          ['default']
        )
      ),
    contentKind: z
      .enum(PLUGIN_CUSTOM_EDITOR_CONTENT_KINDS)
      .optional()
      .meta(
        pluginFieldDoc(
          "`text` (the default) sends the file as text and accepts full-text edits. `bytes` sends the file's raw bytes, for binary formats such as spreadsheets, and accepts full-byte edits.",
          PLUGIN_MANIFEST_V2_SINCE,
          ['bytes']
        )
      )
  })
  .strict()
  .meta({
    id: 'CustomEditorContribution',
    description:
      'An editor for the listed files, shown in the editor tab beside Source. It must list at least one extension or file name. Requires the `sandboxed-ui` execution profile or higher.'
  })

export function customEditorContentKind(editor: {
  contentKind?: PluginCustomEditorContentKind
}): PluginCustomEditorContentKind {
  return editor.contentKind ?? 'text'
}
