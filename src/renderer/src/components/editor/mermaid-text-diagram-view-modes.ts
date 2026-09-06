import { translate } from '@/i18n/i18n'

export type MermaidTextDiagramMode = 'code' | 'split' | 'chart'

type MermaidTextDiagramModeOption = {
  value: MermaidTextDiagramMode
  label: string
}

const MERMAID_TEXT_DIAGRAM_MODES = ['code', 'split', 'chart'] as const

const MERMAID_TEXT_DIAGRAM_MODE_LABELS = {
  code: 'Code',
  split: 'Split',
  chart: 'Chart'
} as const satisfies Record<MermaidTextDiagramMode, string>

export function getMermaidTextDiagramModeOptions(
  i18nPrefix: string
): readonly MermaidTextDiagramModeOption[] {
  return MERMAID_TEXT_DIAGRAM_MODES.map((mode) => ({
    value: mode,
    label: translate(`${i18nPrefix}.${mode}`, MERMAID_TEXT_DIAGRAM_MODE_LABELS[mode])
  }))
}

export function isMermaidTextDiagramMode(value: string): value is MermaidTextDiagramMode {
  return (MERMAID_TEXT_DIAGRAM_MODES as readonly string[]).includes(value)
}
