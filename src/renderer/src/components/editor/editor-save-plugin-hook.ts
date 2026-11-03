import { translate } from '@/i18n/i18n'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import type { AppStoreApi } from './editor-save-queue'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorSaveTrigger } from './editor-save-disk-precondition'
import { hasEditorBytesDraft } from './editor-bytes-documents'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import { adoptEditorSaveText } from './editor-save-text-transform'
import type { PluginHostListEntry } from '../../../../preload/api-types'

const SAVE_HOOK = 'editor.save.before'
// Why errored too: an approved guard whose worker crashed may deny on error; main decides.
const HOOKING_STATUSES: ReadonlySet<PluginHostListEntry['status']> = new Set([
  'running',
  'restarting',
  'idle',
  'errored'
])

/** A plugin refused this save; the message names it and its reason. */
export class EditorSaveDeniedByPluginError extends Error {
  constructor(
    readonly pluginKey: string,
    readonly reason: string
  ) {
    super(
      translate(
        'auto.components.editor.editor.save.deniedByPlugin',
        'The plugin {{plugin}} refused this save: {{reason}}',
        { plugin: pluginKey, reason }
      )
    )
    this.name = 'EditorSaveDeniedByPluginError'
  }
}

/** Synchronous, so a save with no plugin listing the hook takes no extra await. */
export function editorSaveHookWanted(): boolean {
  return (
    typeof window.api?.plugins?.editorSaveHook === 'function' &&
    usePluginPanelsStore
      .getState()
      .plugins.some(
        (plugin) => HOOKING_STATUSES.has(plugin.status) && plugin.hooks?.includes(SAVE_HOOK)
      )
  )
}

/**
 * Runs `editor.save.before` on the text about to be written and returns what to write instead.
 * Throws EditorSaveDeniedByPluginError on a deny. When the buffer still holds the text the hook
 * saw, it takes the hook's text too, so the save leaves it clean; edits made meanwhile stay dirty.
 */
export async function applyEditorSavePluginHook(
  store: AppStoreApi,
  file: OpenFile,
  text: string
): Promise<string> {
  const run = window.api?.plugins?.editorSaveHook
  if (!run) {
    return text
  }
  // Why the record: the saving view may close while the hook runs and a sibling view stays open.
  const recordId = editorBufferIdOfView(store.getState(), file.id)
  const decision = await run({
    workspaceId: file.worktreeId || null,
    path: file.relativePath || file.filePath,
    ...(file.language ? { languageId: file.language } : {}),
    text
  })
  if (decision.kind === 'deny') {
    throw new EditorSaveDeniedByPluginError(decision.pluginKey, decision.reason)
  }
  return adoptEditorSaveText(store, recordId, text, decision.text ?? text)
}

/** The hook for a save the person asked for, or null (no plugin listens, or an autosave or
 *  restart save) so the caller adds no await. Autosave is left alone: a format-on-save mod would
 *  rewrite text under the cursor. */
export function editorSavePluginHook(
  store: AppStoreApi,
  file: OpenFile,
  trigger: EditorSaveTrigger,
  text: string
): Promise<string> | null {
  return (trigger === 'user' || trigger === 'overwrite' || trigger === 'convert') &&
    // Bytes documents (images, binaries edited by plugin editors) are not text to transform.
    !hasEditorBytesDraft(file.id) &&
    editorSaveHookWanted()
    ? applyEditorSavePluginHook(store, file, text)
    : null
}
