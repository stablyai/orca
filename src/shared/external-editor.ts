import type { ExternalEditorSettings } from './types'

export type ExternalEditorOpenRequest = {
  filePath: string
  line?: number | null
  column?: number | null
}

export type ExternalEditorOpenTarget =
  | { kind: 'cli'; command: string; args: string[] }
  | { kind: 'url'; url: string }

type ExternalEditorPreset = {
  command: string
  argsTemplate: string[]
  urlTemplate?: string
}

const CLI_GOTO_TEMPLATE = ['-g', '{path}:{line}:{column}']

const PRESETS: Partial<Record<ExternalEditorSettings['kind'], ExternalEditorPreset>> = {
  vscode: {
    command: 'code',
    argsTemplate: CLI_GOTO_TEMPLATE,
    urlTemplate: 'vscode://file/{path}:{line}:{column}'
  },
  'vscode-insiders': {
    command: 'code-insiders',
    argsTemplate: CLI_GOTO_TEMPLATE,
    urlTemplate: 'vscode-insiders://file/{path}:{line}:{column}'
  },
  cursor: {
    command: 'cursor',
    argsTemplate: CLI_GOTO_TEMPLATE,
    urlTemplate: 'cursor://file/{path}:{line}:{column}'
  },
  'jetbrains-idea': {
    command: 'idea',
    argsTemplate: ['--line', '{line}', '--column', '{column}', '{path}']
  }
}

function normalizeLocation(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return 1
  }
  return Math.floor(value)
}

function formatTemplate(template: string, request: ExternalEditorOpenRequest): string {
  const line = String(normalizeLocation(request.line))
  const column = String(normalizeLocation(request.column))
  return template
    .replaceAll('{path}', request.filePath)
    .replaceAll('{pathEncoded}', encodeURIComponent(request.filePath))
    .replaceAll('{line}', line)
    .replaceAll('{column}', column)
}

function formatArgs(template: string[], request: ExternalEditorOpenRequest): string[] {
  return template.map((part) => formatTemplate(part, request))
}

export function formatExternalEditorOpenTarget(
  settings: ExternalEditorSettings,
  request: ExternalEditorOpenRequest
): ExternalEditorOpenTarget | null {
  if (settings.kind === 'none') {
    return null
  }

  if (settings.kind === 'custom') {
    if (settings.strategy === 'url') {
      const template = settings.urlTemplate?.trim()
      if (!template) {
        return null
      }
      return { kind: 'url', url: formatTemplate(template, request) }
    }

    const command = settings.command?.trim()
    if (!command) {
      return null
    }
    return {
      kind: 'cli',
      command,
      args: formatArgs(
        settings.argsTemplate?.length ? settings.argsTemplate : CLI_GOTO_TEMPLATE,
        request
      )
    }
  }

  const preset = PRESETS[settings.kind]
  if (!preset) {
    return null
  }

  if (settings.strategy === 'url') {
    if (!preset.urlTemplate) {
      return null
    }
    return { kind: 'url', url: formatTemplate(preset.urlTemplate, request) }
  }

  return {
    kind: 'cli',
    command: preset.command,
    args: formatArgs(preset.argsTemplate, request)
  }
}
