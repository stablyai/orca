import type { ArchitectureStatus } from '../architecture-diagram-types'

export const STATUS_COLORS: Record<
  ArchitectureStatus,
  { stroke: string; dimStroke: string; text: string; fill: string; label: string }
> = {
  proposed: {
    stroke: '#3b82f6',
    dimStroke: 'rgba(59,130,246,0.58)',
    text: 'text-blue-500 dark:text-blue-300',
    fill: 'bg-blue-500',
    label: 'Proposed'
  },
  implemented: {
    stroke: '#f59e0b',
    dimStroke: 'rgba(245,158,11,0.58)',
    text: 'text-amber-500 dark:text-amber-300',
    fill: 'bg-amber-500',
    label: 'Implemented'
  },
  verified: {
    stroke: '#10b981',
    dimStroke: 'rgba(16,185,129,0.58)',
    text: 'text-emerald-500 dark:text-emerald-300',
    fill: 'bg-emerald-500',
    label: 'Verified'
  },
  vagrant: {
    stroke: '#f43f5e',
    dimStroke: 'rgba(244,63,94,0.58)',
    text: 'text-rose-500 dark:text-rose-300',
    fill: 'bg-rose-500',
    label: 'Vagrant'
  }
}

export function statusHex(status: ArchitectureStatus | undefined): string | undefined {
  return status ? STATUS_COLORS[status]?.stroke : undefined
}
