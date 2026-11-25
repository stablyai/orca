import { PLUGIN_DECLARATIVE_MESSAGES } from '../declarative/plugin-declarative-message-names'
import {
  PLUGIN_DECLARATIVE_POST_GLOBAL,
  PLUGIN_DECLARATIVE_RUNTIME_FILE,
  PLUGIN_FRAME_RESERVED_SEGMENT
} from './plugin-frame-guest'

const RUNTIME_PATH = `/${PLUGIN_FRAME_RESERVED_SEGMENT}/${PLUGIN_DECLARATIVE_RUNTIME_FILE}`

const scriptJson = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c')

/**
 * Body of the hidden page a declarative panel runs in (served after the guest shell). `entry` is a
 * declared manifest path, so it always resolves inside the plugin's own origin.
 */
export function buildPluginDeclarativeHostBody(entry: string): string {
  const imports = {
    orca: RUNTIME_PATH,
    'orca/jsx-runtime': RUNTIME_PATH,
    'orca/jsx-dev-runtime': RUNTIME_PATH
  }
  const entryPath = `/${entry.split('/').map(encodeURIComponent).join('/')}`
  return (
    `<script type="importmap">${scriptJson({ imports })}</script>\n` +
    '<script type="module">\n' +
    `const name = ${scriptJson(PLUGIN_DECLARATIVE_POST_GLOBAL)}\n` +
    'const post = window[name]\n' +
    'delete window[name]\n' +
    `const report = (error) => post(${scriptJson(PLUGIN_DECLARATIVE_MESSAGES.error)}, ` +
    '{ revision: 0, message: String((error && error.message) || error).slice(0, 4096) })\n' +
    'let runtime = null\n' +
    'try {\n' +
    // Why the URL, not `orca`: the same module instance, and no bare specifier in main's bundle.
    `  const orca = await import(${scriptJson(RUNTIME_PATH)})\n` +
    // Installed before the panel module loads, so state is fetched while it downloads.
    '  runtime = orca.installOrcaDeclarativeRuntime({ post, awaitHydration: true })\n' +
    `  await runtime.boot(await import(${scriptJson(entryPath)}))\n` +
    '} catch (error) {\n' +
    // The runtime's report names the plugin file and line; the fallback covers a runtime that failed.
    "  if (runtime && typeof runtime.report === 'function') runtime.report(error)\n" +
    // Why the console too: main routes guest console errors to `orca plugin logs`.
    '  else { console.error((error && error.stack) || String(error)); report(error) }\n' +
    '}\n' +
    '</script>\n'
  )
}
