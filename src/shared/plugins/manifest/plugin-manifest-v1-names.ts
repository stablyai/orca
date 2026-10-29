import { PLUGIN_V1_CAPABILITY_ALIASES } from '../capabilities/plugin-capabilities'
import { PLUGIN_V1_EVENT_ALIASES } from '../contributions/plugin-event-contribution'
import { canonicalPluginPanelIcon } from '../contributions/plugin-panel-contribution'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapRecords(list: unknown, map: (entry: Record<string, unknown>) => unknown[]): unknown {
  return Array.isArray(list)
    ? list.flatMap((entry) => (isRecord(entry) ? map(entry) : [entry]))
    : list
}

function renameField(field: string, from: string, to: string) {
  return (entry: Record<string, unknown>) => [
    entry[field] === from ? { ...entry, [field]: to } : entry
  ]
}

function labelToTitle({ label, ...entry }: Record<string, unknown>): unknown[] {
  return [label === undefined ? entry : { ...entry, title: label }]
}

/** Rewrites names format 1 used into today's, so v1 manifests keep loading; v2 must use the new names. */
export function upgradePluginManifestV1Names(raw: unknown): unknown {
  if (!isRecord(raw) || raw.manifestVersion !== 1) {
    return raw
  }
  const capabilities = mapRecords(raw.capabilities, (capability) => {
    const kinds = PLUGIN_V1_CAPABILITY_ALIASES.get(String(capability.kind))
    return kinds ? kinds.map((kind) => ({ ...capability, kind })) : [capability]
  })
  if (!isRecord(raw.contributes)) {
    return { ...raw, capabilities }
  }
  // Why drop agents: format 1 accepted entries Orca never read, so they stay inert forever.
  const {
    agents: _inert,
    panels,
    commands,
    keybindings,
    events,
    customEditors,
    themes,
    terminalThemes,
    iconThemes,
    syntaxes,
    ...contributes
  } = raw.contributes
  return {
    ...raw,
    capabilities,
    contributes: {
      ...contributes,
      // Why: format 1 took any icon name and showed `plug` for unknown ones; keep that.
      panels: mapRecords(panels, ({ icon, ...panel }) => {
        const known = typeof icon === 'string' ? canonicalPluginPanelIcon(icon) : null
        return [known ? { ...panel, icon: known } : panel]
      }),
      commands: mapRecords(commands, ({ context, ...command }) => [
        context === undefined
          ? command
          : { ...command, when: context === 'worktree' ? 'workspace' : context }
      ]),
      keybindings: mapRecords(keybindings, renameField('when', 'worktree', 'workspace')),
      themes: mapRecords(themes, labelToTitle),
      terminalThemes: mapRecords(terminalThemes, labelToTitle),
      iconThemes: mapRecords(iconThemes, labelToTitle),
      syntaxes: mapRecords(syntaxes, labelToTitle),
      customEditors: mapRecords(customEditors, ({ fileTypes, ...editor }) => [
        Array.isArray(fileTypes)
          ? { ...editor, extensions: fileTypes.map((fileType) => `.${String(fileType)}`) }
          : editor
      ]),
      events: mapRecords(events, (event) => {
        const on = PLUGIN_V1_EVENT_ALIASES.get(String(event.on))
        return [on ? { ...event, on } : event]
      })
    }
  }
}
