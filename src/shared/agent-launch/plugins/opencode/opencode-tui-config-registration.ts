import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import {
  writeCanonicalOpenCodePluginAtomically,
  writeOverlayOpenCodePluginAtomically
} from './opencode-plugin-atomic-write'

export class InvalidOpenCodeTuiConfigError extends Error {}

/** Register 1.x's explicit TUI entry without changing other settings or overlay targets. */
export function registerOpenCodeTuiPlugin(
  configDir: string,
  entry: string,
  ownership: 'canonical' | 'overlay'
): void {
  const configPath =
    ['tui.jsonc', 'tui.json'].map((name) => join(configDir, name)).find(existsSync) ??
    join(configDir, 'tui.json')
  const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '{}\n'
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== 'object' || !config || Array.isArray(config)) {
    throw new InvalidOpenCodeTuiConfigError('Cannot register OpenCode TUI plugin in invalid config')
  }
  const previous = 'plugin' in config ? config.plugin : undefined
  if (previous !== undefined && !Array.isArray(previous)) {
    throw new InvalidOpenCodeTuiConfigError(
      'Cannot register OpenCode TUI plugin in invalid plugin list'
    )
  }
  const sourceDir = existsSync(configPath) ? dirname(realpathSync(configPath)) : configDir
  const entries: unknown[] = previous ?? []
  const plugin = pathToFileURL(entry).href
  const rebase = (item: unknown): unknown =>
    ownership === 'overlay' && typeof item === 'string' && /^\.{1,2}[\\/]/.test(item)
      ? pathToFileURL(resolve(sourceDir, item)).href
      : item
  const plugins = entries.map((item) =>
    Array.isArray(item) && typeof item[0] === 'string'
      ? [rebase(item[0]), ...item.slice(1)]
      : rebase(item)
  )
  if (!plugins.includes(plugin)) {
    plugins.push(plugin)
  }
  const updated = applyEdits(
    text,
    modify(text, ['plugin'], plugins, {
      formattingOptions: { tabSize: 2, insertSpaces: true }
    })
  )
  if (updated === text) {
    return
  }
  const write =
    ownership === 'canonical'
      ? writeCanonicalOpenCodePluginAtomically
      : writeOverlayOpenCodePluginAtomically
  write(configPath, updated)
}
