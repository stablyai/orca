import type { RefinementCtx } from 'zod'
import { isPluginCommandAliasActionId } from '../contributions/plugin-command-actions'
import { getKeybindingConflictIdentity } from '../../keybindings'
import {
  PLUGIN_EVENT_CAPABILITY,
  type PluginEventName
} from '../contributions/plugin-event-contribution'
import type { PluginFileMatch } from '../contributions/plugin-file-match'

type IdentifiedContribution = { id: string }
type PathContribution = { path: string }

type ContributionValidationManifest = {
  main?: string
  contributes: {
    panels: IdentifiedContribution[]
    commands: (IdentifiedContribution & { action?: string; when?: 'global' | 'workspace' })[]
    events: { on: PluginEventName }[]
    languagePacks: { locale: string }[]
    keybindings: { command: string; key: string; when?: 'global' | 'workspace' }[]
    vmRecipes: PathContribution[]
    themes: IdentifiedContribution[]
    terminalThemes: IdentifiedContribution[]
    iconThemes: IdentifiedContribution[]
    syntaxes: (IdentifiedContribution & PluginFileMatch & { scopeName: string })[]
    customEditors: (IdentifiedContribution & PluginFileMatch)[]
    newFiles: IdentifiedContribution[]
  }
  capabilities: { kind: string }[]
}

function rejectDuplicateValues(
  entries: readonly unknown[],
  valueOf: (entry: unknown) => string,
  path: string,
  label: string,
  ctx: RefinementCtx
): void {
  const seen = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const value = valueOf(entry)
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', path, index],
        message: `duplicate ${label}: ${value}`
      })
    }
    seen.add(value)
  }
}

export function validatePluginManifestContributions(
  manifest: ContributionValidationManifest,
  ctx: RefinementCtx
): void {
  for (const path of [
    'panels',
    'commands',
    'themes',
    'terminalThemes',
    'iconThemes',
    'syntaxes',
    'customEditors',
    'newFiles'
  ] as const) {
    rejectDuplicateValues(
      manifest.contributes[path],
      (entry) => (entry as IdentifiedContribution).id,
      path,
      `${path} id`,
      ctx
    )
  }
  rejectDuplicateValues(
    manifest.contributes.syntaxes.map((syntax) => syntax.scopeName),
    String,
    'syntaxes',
    'syntax scope name',
    ctx
  )
  for (const point of ['syntaxes', 'customEditors'] as const) {
    for (const [index, item] of manifest.contributes[point].entries()) {
      for (const field of ['extensions', 'filenames'] as const) {
        const values = item[field].map((value) => value.toLowerCase())
        if (new Set(values).size !== values.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['contributes', point, index, field],
            message: `duplicate ${field === 'extensions' ? 'extension' : 'file name'}`
          })
        }
      }
    }
  }
  for (const [index, editor] of manifest.contributes.customEditors.entries()) {
    if (editor.extensions.length === 0 && editor.filenames.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'customEditors', index, 'extensions'],
        message: 'must list at least one extension or file name'
      })
    }
  }
  rejectDuplicateValues(
    manifest.contributes.languagePacks,
    (entry) => (entry as { locale: string }).locale.toLowerCase(),
    'languagePacks',
    'language pack locale',
    ctx
  )
  rejectDuplicateValues(
    manifest.contributes.vmRecipes,
    (entry) => (entry as PathContribution).path,
    'vmRecipes',
    'vmRecipes path',
    ctx
  )
  const keybindingIdentities = new Set<string>()
  for (const [index, keybinding] of manifest.contributes.keybindings.entries()) {
    const identities = (['darwin', 'linux', 'win32'] as const).map((platform) =>
      getKeybindingConflictIdentity(keybinding.key, platform)
    )
    if (identities.some((identity) => keybindingIdentities.has(identity))) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'keybindings', index],
        message: `duplicate keybinding: ${keybinding.key.toLowerCase()}`
      })
    }
    identities.forEach((identity) => keybindingIdentities.add(identity))
  }

  const commands = new Map(manifest.contributes.commands.map((command) => [command.id, command]))
  for (const [index, command] of manifest.contributes.commands.entries()) {
    if (command.action !== undefined && !isPluginCommandAliasActionId(command.action)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'commands', index, 'action'],
        message: `unknown built-in action: ${command.action}`
      })
    }
  }
  for (const [index, keybinding] of manifest.contributes.keybindings.entries()) {
    const command = commands.get(keybinding.command)
    if (!command) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'keybindings', index, 'command'],
        message: `unknown contributed command: ${keybinding.command}`
      })
      continue
    }
    const commandWhen = command.when ?? 'global'
    if (keybinding.when !== undefined && keybinding.when !== commandWhen) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'keybindings', index, 'when'],
        message: "must match its command's when"
      })
    }
  }

  if (
    !manifest.main &&
    manifest.contributes.commands.some((command) => command.action === undefined)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['main'],
      message: 'required when contributes.commands contains a worker command'
    })
  }
  if (!manifest.main && manifest.contributes.events.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['main'],
      message: 'required when contributes.events is non-empty'
    })
  }
  for (const [index, subscription] of manifest.contributes.events.entries()) {
    const required = PLUGIN_EVENT_CAPABILITY[subscription.on]
    if (!manifest.capabilities.some((capability) => capability.kind === required)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributes', 'events', index, 'on'],
        message: `${subscription.on} requires the ${required} capability`
      })
    }
  }
}
