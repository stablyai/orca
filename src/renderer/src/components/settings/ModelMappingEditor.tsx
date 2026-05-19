import React from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import type { ClaudeModelMapping } from '../../../../shared/types'

// Three named tiers Claude routes against. Order here drives the rendered list.
const TIERS = ['opus', 'sonnet', 'haiku'] as const
type Tier = (typeof TIERS)[number]

export type ModelMappingEditorProps = {
  mapping: ClaudeModelMapping
  defaults: ClaudeModelMapping
  onChange: (next: ClaudeModelMapping) => void
  // Controlled-collapse: parent owns whether the disclosure is open. When
  // omitted the <details> defaults to closed.
  open?: boolean
  onToggleOpen?: (open: boolean) => void
  // P3 T19 — Refresh defaults timestamp + button. Optional so legacy call
  // sites keep working unchanged (no row rendered when omitted).
  defaultsFetchedAt?: number | null
  onRefreshDefaults?: () => void
  // P3 T19 — Parent-controlled "refresh in flight" flag so the button can be
  // disabled while the IPC roundtrip is pending.
  refreshing?: boolean
  // P3 T19 — Override the clock for deterministic tests. Defaults to `Date.now()`.
  nowMs?: number
}

/**
 * Pure helper: set or clear a single model-mapping tier.
 *
 * Exported for direct testing so the renderer suite (which runs under
 * `environment: 'node'` with no jsdom) doesn't need to simulate input events
 * to cover the tier-manipulation logic. Empty / whitespace values strip the
 * key entirely so the consumer's mapping object stays canonical — a tier
 * left unset means "use provider default", which differs from "explicit
 * empty string".
 */
export function setMappingTier(
  current: ClaudeModelMapping,
  tier: Tier,
  value: string | undefined
): ClaudeModelMapping {
  const next: ClaudeModelMapping = { ...current }
  if (value === undefined || value.trim() === '') {
    delete next[tier]
  } else {
    next[tier] = value
  }
  return next
}

/**
 * Format an age-in-ms as a compact relative string.
 *
 * Why: the registry timestamp surfaces in ModelMappingEditor as "Defaults
 * updated Nd ago" / "Nh ago" / "Nm ago" / "just now". Pure helper so tests
 * can pin the clock without rendering the component, and so the rendering
 * code stays free of date math. Negative deltas (clock skew) clamp to
 * "just now" rather than rendering a nonsense negative duration.
 */
export function formatRelativeAge(ageMs: number): string {
  if (ageMs < 0) return 'just now'
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function tierLabel(tier: Tier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

/**
 * Per-account model mapping editor — fully controlled.
 *
 * The parent owns both the mapping value and the open/collapsed state; this
 * keeps the component trivially testable as a static render and matches the
 * three-export pattern used by the P1 provider forms (pure builder + view +
 * wrapper). No internal `useState`.
 */
export function ModelMappingEditor(props: ModelMappingEditorProps): React.JSX.Element {
  const handleTierChange = (tier: Tier, value: string): void => {
    props.onChange(setMappingTier(props.mapping, tier, value))
  }
  const handleReset = (tier: Tier): void => {
    props.onChange(setMappingTier(props.mapping, tier, undefined))
  }

  // P3 T19 — render the defaults source row only when the parent opts in by
  // wiring `onRefreshDefaults`. Keeps the legacy zero-prop render byte-stable.
  const showRefreshRow = typeof props.onRefreshDefaults === 'function'
  const now = props.nowMs ?? Date.now()
  const defaultsLabel =
    props.defaultsFetchedAt == null
      ? 'Defaults: built-in'
      : `Defaults updated ${formatRelativeAge(now - props.defaultsFetchedAt)}`

  return (
    <details
      open={props.open}
      onToggle={(e) =>
        props.onToggleOpen?.((e.target as HTMLDetailsElement).open)
      }
      className="border rounded-md"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        Model mapping (advanced)
      </summary>
      <div className="px-3 py-2 space-y-3">
        {showRefreshRow ? (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{defaultsLabel}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Refresh defaults"
              disabled={props.refreshing === true}
              onClick={() => props.onRefreshDefaults?.()}
            >
              {props.refreshing === true ? 'Refreshing…' : 'Refresh defaults'}
            </Button>
          </div>
        ) : null}
        {TIERS.map((tier) => {
          const userValue = props.mapping[tier]
          const defaultValue = props.defaults[tier] ?? ''
          // "Customized" = user explicitly set a non-empty value. Drives the
          // Reset button, bold label, and dot indicator.
          const isCustomized = userValue !== undefined && userValue !== ''
          return (
            <div key={tier} className="space-y-1">
              <Label
                htmlFor={`mm-${tier}`}
                className={isCustomized ? 'font-bold' : ''}
              >
                {tierLabel(tier)}
                {isCustomized ? (
                  <span aria-hidden="true" className="ml-1 text-primary">
                    •
                  </span>
                ) : null}
              </Label>
              <div className="flex gap-2">
                <Input
                  id={`mm-${tier}`}
                  placeholder={defaultValue}
                  value={userValue ?? ''}
                  onChange={(e) => handleTierChange(tier, e.target.value)}
                />
                {isCustomized ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleReset(tier)}
                    aria-label={`Reset ${tier}`}
                  >
                    Reset
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </details>
  )
}
