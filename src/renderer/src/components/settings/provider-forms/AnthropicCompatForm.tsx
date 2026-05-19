import React, { useState } from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import type { AnthropicCompatPreset } from '../../../../../shared/types'

// Server-side preset → baseUrl table. The renderer never has to know the URL
// for non-custom presets — these are surfaced as read-only context so users
// understand what they're connecting to, but the actual handler fills them in.
const BAKED_BASE_URLS: Record<Exclude<AnthropicCompatPreset, 'custom'>, string> = {
  zai: 'https://api.z.ai/api/anthropic',
  kimi: 'https://api.moonshot.ai/anthropic',
  minimax: 'https://api.minimax.io/anthropic'
}

type PresetMeta = {
  preset: AnthropicCompatPreset
  label: string
  description: string
}

const PRESETS: readonly PresetMeta[] = [
  { preset: 'zai', label: 'z.ai (GLM)', description: 'Zhipu AI GLM-5.1' },
  { preset: 'kimi', label: 'Moonshot Kimi', description: 'kimi-k2.6' },
  { preset: 'minimax', label: 'MiniMax', description: 'MiniMax-M2.7' },
  { preset: 'custom', label: 'Custom', description: 'Any Anthropic-compatible proxy' }
]

export type AnthropicCompatSubmit = {
  authMethod: 'anthropic-compat'
  label?: string
  secretFromUser: string
  // baseUrl is only carried for the custom preset — non-custom presets resolve
  // their baseUrl server-side from the BAKED_BASE_URLS table to keep the
  // renderer free of provider-endpoint drift.
  providerConfig: { preset: AnthropicCompatPreset; baseUrl?: string }
}

export type AnthropicCompatBuilderInput = {
  preset: AnthropicCompatPreset
  token: string
  label?: string
  baseUrl?: string
}

/**
 * Validate + build the submit payload for the Anthropic-compat form.
 *
 * Returned as a pure helper so tests can call it directly without rendering
 * the React tree — the renderer test suite runs under `environment: 'node'`
 * with no jsdom, so DOM-event-driven testing is not available.
 */
export function buildAnthropicCompatSubmit(
  input: AnthropicCompatBuilderInput
): AnthropicCompatSubmit | { error: string } {
  const token = input.token.trim()
  if (!token) {
    return { error: 'Provider auth token is required.' }
  }
  const baseUrl = input.baseUrl?.trim() ?? ''
  if (input.preset === 'custom' && !baseUrl) {
    return { error: 'Base URL is required for the custom provider.' }
  }
  const trimmedLabel = input.label?.trim() ?? ''
  const providerConfig: { preset: AnthropicCompatPreset; baseUrl?: string } = {
    preset: input.preset
  }
  if (input.preset === 'custom') {
    providerConfig.baseUrl = baseUrl
  }
  return {
    authMethod: 'anthropic-compat',
    label: trimmedLabel === '' ? undefined : trimmedLabel,
    secretFromUser: token,
    providerConfig
  }
}

export type AnthropicCompatFormViewProps = {
  preset: AnthropicCompatPreset
  token: string
  label: string
  baseUrl: string
  error: string | null
  onChangePreset: (p: AnthropicCompatPreset) => void
  onChangeToken: (v: string) => void
  onChangeLabel: (v: string) => void
  onChangeBaseUrl: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}

/**
 * Stateless render of the Anthropic-compat form.
 *
 * Exported separately from `AnthropicCompatForm` so tests can call this as a
 * plain function (no hook dispatcher) and traverse the returned element tree.
 * The stateful wrapper below owns the `useState` calls.
 */
export function AnthropicCompatFormView({
  preset,
  token,
  label,
  baseUrl,
  error,
  onChangePreset,
  onChangeToken,
  onChangeLabel,
  onChangeBaseUrl,
  onSubmit,
  onCancel
}: AnthropicCompatFormViewProps): React.JSX.Element {
  const bakedUrl = preset === 'custom' ? null : BAKED_BASE_URLS[preset]
  const presetMeta = PRESETS.find((p) => p.preset === preset)
  return (
    <form
      aria-label="Anthropic-compatible provider form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-3"
    >
      <div role="tablist" aria-label="Preset" className="flex flex-wrap gap-1">
        {PRESETS.map((p) => {
          const selected = p.preset === preset
          return (
            <Button
              key={p.preset}
              type="button"
              role="tab"
              aria-selected={selected}
              variant={selected ? 'default' : 'outline'}
              size="sm"
              onClick={() => onChangePreset(p.preset)}
            >
              {p.label}
            </Button>
          )
        })}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="acf-label">Label (optional)</Label>
        <Input
          id="acf-label"
          aria-label="Label"
          autoFocus
          placeholder={`e.g. ${presetMeta?.label ?? ''}`}
          value={label}
          onChange={(e) => onChangeLabel(e.target.value)}
        />
      </div>
      {bakedUrl ? (
        <p className="text-xs text-muted-foreground" data-testid="baked-base-url">
          Base URL:{' '}
          <code className="font-mono text-[11px]">{bakedUrl}</code>
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor="acf-baseurl">Base URL</Label>
          <Input
            id="acf-baseurl"
            aria-label="Base URL"
            placeholder="https://your-proxy/anthropic"
            value={baseUrl}
            onChange={(e) => onChangeBaseUrl(e.target.value)}
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Label htmlFor="acf-token">Auth token</Label>
        <Input
          id="acf-token"
          aria-label="Auth token"
          type="password"
          placeholder="provider token"
          value={token}
          onChange={(e) => onChangeToken(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'acf-token-error' : undefined}
        />
        {error ? (
          <p id="acf-token-error" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button type="submit">Add account</Button>
      </div>
    </form>
  )
}

export type AnthropicCompatFormProps = {
  onSubmit: (input: AnthropicCompatSubmit) => void
  onCancel: () => void
}

export function AnthropicCompatForm({
  onSubmit,
  onCancel
}: AnthropicCompatFormProps): React.JSX.Element {
  const [preset, setPreset] = useState<AnthropicCompatPreset>('zai')
  const [token, setToken] = useState('')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (): void => {
    const result = buildAnthropicCompatSubmit({ preset, token, label, baseUrl })
    if ('error' in result) {
      setError(result.error)
      return
    }
    setError(null)
    onSubmit(result)
  }

  return (
    <AnthropicCompatFormView
      preset={preset}
      token={token}
      label={label}
      baseUrl={baseUrl}
      error={error}
      onChangePreset={(p) => {
        setPreset(p)
        if (error) setError(null)
      }}
      onChangeToken={(v) => {
        setToken(v)
        if (error) setError(null)
      }}
      onChangeLabel={setLabel}
      onChangeBaseUrl={(v) => {
        setBaseUrl(v)
        if (error) setError(null)
      }}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  )
}
