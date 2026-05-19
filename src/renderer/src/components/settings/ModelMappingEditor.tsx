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
