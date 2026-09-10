import { translate } from '@/i18n/i18n'
/** Tone lives in the Markdown as a callout marker, so the document contract is untouched. */
export type MaestroAnnotationTone = 'observation' | 'highlight' | 'decision' | 'warning' | 'blocker'

type MaestroAnnotationToneEntry = { tone: MaestroAnnotationTone; label: string; hint: string }

const ANNOTATION_TONE_ORDER: readonly {
  tone: MaestroAnnotationTone
  labelKey: string
  fallbackLabel: string
  hintKey: string
  fallbackHint: string
}[] = [
  {
    tone: 'observation',
    labelKey: 'auto.components.maestro.maestro.annotation.tone.39ef8efa3f',
    fallbackLabel: 'Observation',
    hintKey: 'auto.components.maestro.maestro.annotation.tone.observationHint',
    fallbackHint: 'Context worth keeping, nothing pending'
  },
  {
    tone: 'highlight',
    labelKey: 'auto.components.maestro.maestro.annotation.tone.c87ad9fa13',
    fallbackLabel: 'Post-it',
    hintKey: 'auto.components.maestro.maestro.annotation.tone.highlightHint',
    fallbackHint: 'Pinned for attention'
  },
  {
    tone: 'decision',
    labelKey: 'auto.components.maestro.maestro.annotation.tone.2af310a116',
    fallbackLabel: 'Decision',
    hintKey: 'auto.components.maestro.maestro.annotation.tone.decisionHint',
    fallbackHint: 'Settled, act on it'
  },
  {
    tone: 'warning',
    labelKey: 'auto.components.maestro.maestro.annotation.tone.d052036308',
    fallbackLabel: 'Warning',
    hintKey: 'auto.components.maestro.maestro.annotation.tone.warningHint',
    fallbackHint: 'Needs a human before it moves'
  },
  {
    tone: 'blocker',
    labelKey: 'auto.components.maestro.maestro.annotation.tone.b4f98f49a1',
    fallbackLabel: 'Blocker',
    hintKey: 'auto.components.maestro.maestro.annotation.tone.blockerHint',
    fallbackHint: 'Work is stopped here'
  }
]

/** Translated at call time: a module-level translate() would resolve before i18n loads. */
export function maestroAnnotationTones(): MaestroAnnotationToneEntry[] {
  return ANNOTATION_TONE_ORDER.map((entry) => ({
    tone: entry.tone,
    label: translate(entry.labelKey, entry.fallbackLabel),
    hint: translate(entry.hintKey, entry.fallbackHint)
  }))
}

const MARKER_PATTERN = /^>\s*\[!([A-Za-z]+)\]\s*$/
const TONE_BY_MARKER: Record<string, MaestroAnnotationTone> = {
  observation: 'observation',
  note: 'observation',
  highlight: 'highlight',
  important: 'highlight',
  decision: 'decision',
  tip: 'decision',
  warning: 'warning',
  blocker: 'blocker',
  caution: 'blocker'
}

function markerFor(tone: MaestroAnnotationTone): string {
  return `> [!${tone.toUpperCase()}]`
}

function markerLineIndex(lines: readonly string[]): number {
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      continue
    }
    return MARKER_PATTERN.test(line.trim()) ? index : -1
  }
  return -1
}

export function readMaestroAnnotationTone(markdown: string | undefined): MaestroAnnotationTone {
  if (!markdown) {
    return 'observation'
  }
  const lines = markdown.split('\n')
  const index = markerLineIndex(lines)
  if (index < 0) {
    return 'observation'
  }
  const marker = MARKER_PATTERN.exec(lines[index].trim())?.[1]?.toLowerCase()
  return (marker && TONE_BY_MARKER[marker]) || 'observation'
}

export function writeMaestroAnnotationTone(markdown: string, tone: MaestroAnnotationTone): string {
  const lines = markdown.split('\n')
  const index = markerLineIndex(lines)
  if (index >= 0) {
    if (tone === 'observation') {
      const remainder = lines.slice(index + 1)
      while (remainder[0]?.trim() === '') {
        remainder.shift()
      }
      return [...lines.slice(0, index), ...remainder].join('\n')
    }
    return [...lines.slice(0, index), markerFor(tone), ...lines.slice(index + 1)].join('\n')
  }
  if (tone === 'observation') {
    return markdown
  }
  return markdown.trim() ? `${markerFor(tone)}\n\n${markdown}` : `${markerFor(tone)}\n\n`
}

export function stripMaestroAnnotationMarker(markdown: string | undefined): string {
  if (!markdown) {
    return ''
  }
  const lines = markdown.split('\n')
  const index = markerLineIndex(lines)
  return index < 0 ? markdown : [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n')
}
