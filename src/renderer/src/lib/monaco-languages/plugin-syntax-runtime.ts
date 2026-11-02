import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { PluginSyntaxMetadata } from '../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { parsePluginSyntaxPayload } from '../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { pluginSyntaxRevisionKey, recordPluginSyntaxFailure } from '@/store/plugin-syntax-failures'
import { createPluginSyntaxEngine, type PluginSyntaxEngine } from './plugin-syntax-engine'
import { PluginSyntaxSlotPool, type PluginSyntaxLease } from './plugin-syntax-slot-pool'

let pool: PluginSyntaxSlotPool<PluginSyntaxEngine> | null = null

function slotPool(): PluginSyntaxSlotPool<PluginSyntaxEngine> {
  pool ??= new PluginSyntaxSlotPool({
    register: (languageId) => monaco.languages.register({ id: languageId }),
    create: (languageId, key) => {
      const syntaxId = key.slice(0, key.lastIndexOf('@'))
      return createPluginSyntaxEngine({
        monaco,
        languageId,
        load: async () => parsePluginSyntaxPayload(await window.api.plugins.loadSyntax(syntaxId)),
        createWorker: () =>
          new Worker(new URL('./plugin-grammar.worker.ts', import.meta.url), { type: 'module' }),
        onFailure: (reason) => recordPluginSyntaxFailure(key, reason)
      })
    }
  })
  return pool
}

/** A Monaco language id that highlights with this plugin syntax, held until released. Each
 *  revision gets its own slot, so a plugin update re-highlights open files with the new grammar. */
export function acquirePluginSyntaxLanguage(
  syntax: PluginSyntaxMetadata
): PluginSyntaxLease | null {
  const lease = slotPool().acquire(pluginSyntaxRevisionKey(syntax))
  if (!lease) {
    console.warn(`[plugins] ${syntax.id} shows plain text: every syntax slot is in use`)
  }
  return lease
}
