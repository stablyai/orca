import { useMemo } from 'react'
import { create } from 'zustand'
import type { PluginHostCustomEditor, PluginHostListEntry } from '../../../preload/api-types'
import { matchPluginFile } from '../../../shared/plugins/contributions/plugin-file-match'
import { customEditorMayOpenByDefault } from '../../../shared/plugins/contributions/plugin-custom-editor-core-file-types'
import { isLivePlugin, keyedPluginContribution, usePluginListDerived } from './plugin-panels'

/** A custom editor from an enabled plugin. `key` is unique across plugins; `iconUrl` is its own
 *  tab icon, else the plugin's. */
export type ActivePluginCustomEditor = PluginHostCustomEditor & {
  key: string
  pluginKey: string
  pluginName: string
  iconUrl?: string
}

/** The per-file view a user picked in the toggle: an editor key, or `source`. */
export type CustomEditorViewChoice = string

const SOURCE_CHOICE = 'source'

export function collectActivePluginCustomEditors(
  plugins: readonly PluginHostListEntry[]
): ActivePluginCustomEditor[] {
  return plugins
    .filter(isLivePlugin)
    .flatMap((plugin) =>
      (plugin.customEditors ?? []).map((editor) => keyedPluginContribution(plugin, editor))
    )
}

/** Editors that open this file, `default` priority first. A plugin never opens an Orca-core file
 *  type by default, so there its editors are only offered. Ties go by plugin key, not list order. */
export function customEditorsForFile(
  filePath: string,
  editors: readonly ActivePluginCustomEditor[]
): ActivePluginCustomEditor[] {
  const matching = editors.flatMap((editor) => {
    const match = matchPluginFile(filePath, editor)
    if (match === null) {
      return []
    }
    const takesDefault =
      editor.priority === 'default' && customEditorMayOpenByDefault(filePath, match)
    return [{ ...editor, priority: takesDefault ? ('default' as const) : ('option' as const) }]
  })
  const byPlugin = (a: ActivePluginCustomEditor, b: ActivePluginCustomEditor): number =>
    a.pluginKey < b.pluginKey ? -1 : a.pluginKey > b.pluginKey ? 1 : 0
  return [
    ...matching.filter((editor) => editor.priority === 'default').sort(byPlugin),
    ...matching.filter((editor) => editor.priority !== 'default')
  ]
}

/** The editor a file shows: the user's pick while it still exists, else the first default one. */
export function resolveCustomEditorChoice(
  editors: readonly ActivePluginCustomEditor[],
  choice: CustomEditorViewChoice | undefined
): ActivePluginCustomEditor | null {
  if (choice === SOURCE_CHOICE) {
    return null
  }
  const picked = choice ? editors.find((editor) => editor.key === choice) : undefined
  return picked ?? editors.find((editor) => editor.priority === 'default') ?? null
}

type CustomEditorViewState = {
  choices: Record<string, CustomEditorViewChoice>
  setChoice: (fileId: string, choice: CustomEditorViewChoice) => void
}

/** Why session-only: a pick names a plugin that may be gone next launch; defaults then apply. */
export const useCustomEditorViewStore = create<CustomEditorViewState>()((set) => ({
  choices: {},
  setChoice: (fileId, choice) =>
    set((state) => ({ choices: { ...state.choices, [fileId]: choice } }))
}))

/** Custom editors of enabled plugins, sharing the plugin-list refresh. */
export function usePluginCustomEditors(): ActivePluginCustomEditor[] {
  return usePluginListDerived(collectActivePluginCustomEditors)
}

/** The enabled editors for one file and the user's pick among them. */
export function useFileCustomEditors(
  fileId: string | null,
  filePath: string | undefined
): {
  customEditors: ActivePluginCustomEditor[]
  customEditorChoice: CustomEditorViewChoice | undefined
} {
  const all = usePluginCustomEditors()
  const customEditors = useMemo(
    () => (filePath ? customEditorsForFile(filePath, all) : []),
    [filePath, all]
  )
  const customEditorChoice = useCustomEditorViewStore((state) =>
    fileId ? state.choices[fileId] : undefined
  )
  return { customEditors, customEditorChoice }
}

/** The plugin editor an editor tab shows its file in, or null for Source and non-edit views. */
export function useTabCustomEditor(file: {
  id: string
  filePath: string
  mode: string
}): ActivePluginCustomEditor | null {
  const isEdit = file.mode === 'edit'
  const { customEditors, customEditorChoice } = useFileCustomEditors(
    isEdit ? file.id : null,
    isEdit ? file.filePath : undefined
  )
  return resolveCustomEditorChoice(customEditors, customEditorChoice)
}
