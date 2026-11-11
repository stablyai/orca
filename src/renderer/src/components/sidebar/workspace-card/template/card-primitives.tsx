import React from 'react'
import { PluginDeclarativeBadge } from '@/components/plugins/declarative/PluginDeclarativeDisplay'
import { PluginDeclarativeIconGlyph } from '@/components/plugins/declarative/plugin-declarative-icons'
import type { PluginDeclarativeTone } from '../../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { cn } from '@/lib/class-names'
import { cardElement, type CardHostElement } from './card-template-compiler'

const GAP: Readonly<Record<string, string>> = {
  xs: 'gap-0.5',
  sm: 'gap-1',
  md: 'gap-1.5',
  lg: 'gap-2'
}
const ALIGN: Readonly<Record<string, string>> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end'
}
const JUSTIFY: Readonly<Record<string, string>> = {
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between'
}
const OVERFLOW: Readonly<Record<string, string>> = {
  clip: 'overflow-hidden',
  visible: 'overflow-visible'
}
// Markers Orca's own code and tests select on; a template may only reuse these.
const MARKERS: Readonly<Record<string, string>> = {
  'parent-content': 'data-worktree-card-parent-content',
  'meta-row': 'data-worktree-card-meta-row',
  'hover-trigger': 'data-worktree-card-hover-trigger'
}

const BOX_PROPS = [
  'gap',
  'align',
  'justify',
  'fill',
  'grow',
  'keep',
  'push',
  'inset',
  'overflow',
  'hoverGroup',
  'marker'
] as const

function pick(map: Readonly<Record<string, string>>, value: unknown): string | undefined {
  return typeof value === 'string' && Object.hasOwn(map, value) ? map[value] : undefined
}

function boxAttrs(
  props: Readonly<Record<string, unknown>>,
  column: boolean
): Record<string, unknown> {
  const marker = pick(MARKERS, props.marker)
  return {
    className: cn(
      'flex',
      // A box that keeps its size never needs to shrink below its content.
      props.keep !== true && 'min-w-0',
      column && 'flex-col',
      pick(GAP, props.gap),
      pick(ALIGN, props.align),
      pick(JUSTIFY, props.justify),
      props.fill === true && 'w-full',
      props.grow === true && 'flex-1',
      props.keep === true && 'shrink-0',
      props.push === true && 'ml-auto',
      props.inset === 'end' && 'pr-1.5',
      pick(OVERFLOW, props.overflow),
      props.hoverGroup === true && 'group/worktree-card'
    ),
    ...(marker ? { [marker]: '' } : {})
  }
}

export const Row: CardHostElement = {
  kind: 'host',
  props: BOX_PROPS,
  resolve: (props) => ({ tag: 'div', attrs: boxAttrs(props, false) })
}

export const Stack: CardHostElement = {
  kind: 'host',
  props: BOX_PROPS,
  resolve: (props) => ({ tag: 'div', attrs: boxAttrs(props, true) })
}

const TEXT_SIZE: Readonly<Record<string, string>> = {
  title: 'text-[13px] leading-5',
  body: 'text-xs',
  meta: 'text-2xs leading-none',
  micro: 'text-3xs leading-none'
}
// Same tone vocabulary as components panels; colour only carries state.
const TONE: Readonly<Record<string, string>> = {
  neutral: 'text-foreground',
  accent: 'text-primary',
  success: 'text-status-success',
  warning: 'text-status-warning-text',
  danger: 'text-destructive'
}
const BADGE_TONES: readonly PluginDeclarativeTone[] = [
  'neutral',
  'accent',
  'success',
  'warning',
  'danger'
]

function toText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

type Props = Readonly<Record<string, unknown>>

function text(props: Props): React.ReactNode {
  return (
    <span
      className={cn(
        'min-w-0',
        pick(TEXT_SIZE, props.size) ?? TEXT_SIZE.body,
        props.muted === true ? 'text-muted-foreground' : (pick(TONE, props.tone) ?? TONE.neutral),
        props.weight === 'medium' && 'font-medium',
        props.weight === 'semibold' && 'font-semibold',
        props.mono === true && 'font-mono',
        props.truncate === true && 'truncate'
      )}
    >
      {toText(props.text)}
    </span>
  )
}

function badge(props: Props): React.ReactNode {
  const tone = BADGE_TONES.find((candidate) => candidate === props.tone)
  return <PluginDeclarativeBadge tone={tone}>{toText(props.text)}</PluginDeclarativeBadge>
}

function icon(props: Props): React.ReactNode {
  return (
    <PluginDeclarativeIconGlyph
      name={typeof props.name === 'string' ? props.name : ''}
      className={cn('size-3 shrink-0', pick(TONE, props.tone) ?? 'text-muted-foreground')}
    />
  )
}

/** Primitives draw from props alone, so they work under any context. */
export const CARD_PRIMITIVES = {
  Row,
  Stack,
  Text: cardElement<unknown>(['text', 'size', 'tone', 'muted', 'weight', 'mono', 'truncate'], text),
  Badge: cardElement<unknown>(['text', 'tone'], badge),
  Icon: cardElement<unknown>(['name', 'tone'], icon)
}
