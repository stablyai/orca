import React, { useState } from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'

export type AnthropicApiKeySubmit = {
  authMethod: 'anthropic-api-key'
  label?: string
  secretFromUser: string
}

export type AnthropicApiKeyFormProps = {
  onSubmit: (input: AnthropicApiKeySubmit) => void
  onCancel: () => void
}

/**
 * Validate + build the submit payload for the Anthropic API key form.
 *
 * Returned as a pure helper so tests can call it directly without rendering
 * the React tree — the renderer test suite runs under `environment: 'node'`
 * with no jsdom, so DOM-event-driven testing is not available.
 */
export function buildAnthropicApiKeySubmit(input: {
  label: string
  apiKey: string
}): { ok: true; payload: AnthropicApiKeySubmit } | { ok: false; error: string } {
  const trimmedKey = input.apiKey.trim()
  if (!trimmedKey) {
    return { ok: false, error: 'API key is required.' }
  }
  const trimmedLabel = input.label.trim()
  return {
    ok: true,
    payload: {
      authMethod: 'anthropic-api-key',
      label: trimmedLabel === '' ? undefined : trimmedLabel,
      secretFromUser: trimmedKey
    }
  }
}

export type AnthropicApiKeyFormViewProps = {
  label: string
  apiKey: string
  showKey: boolean
  error: string | null
  onLabelChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onToggleShowKey: () => void
  onSubmit: () => void
  onCancel: () => void
}

/**
 * Stateless render of the API-key form.
 *
 * Exported separately from `AnthropicApiKeyForm` so tests can call this as a
 * plain function (no hook dispatcher) and traverse the returned element tree.
 * The stateful wrapper below owns the `useState` calls.
 */
export function AnthropicApiKeyFormView({
  label,
  apiKey,
  showKey,
  error,
  onLabelChange,
  onApiKeyChange,
  onToggleShowKey,
  onSubmit,
  onCancel
}: AnthropicApiKeyFormViewProps): React.JSX.Element {
  return (
    <form
      aria-label="Anthropic API key form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="aak-label">Label (optional)</Label>
        <Input
          id="aak-label"
          aria-label="Label"
          autoFocus
          placeholder="e.g. Work API key"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="aak-key">API key</Label>
        <div className="flex gap-2">
          <Input
            id="aak-key"
            aria-label="API key"
            type={showKey ? 'text' : 'password'}
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'aak-key-error' : undefined}
          />
          <Button
            type="button"
            variant="outline"
            onClick={onToggleShowKey}
            aria-pressed={showKey}
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
          >
            {showKey ? 'Hide' : 'Show'}
          </Button>
        </div>
        {error ? (
          <p id="aak-key-error" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onCancel} aria-label="Back">
          Back
        </Button>
        <Button type="submit" aria-label="Add account">
          Add account
        </Button>
      </div>
    </form>
  )
}

export function AnthropicApiKeyForm({
  onSubmit,
  onCancel
}: AnthropicApiKeyFormProps): React.JSX.Element {
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (): void => {
    const result = buildAnthropicApiKeySubmit({ label, apiKey })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    onSubmit(result.payload)
  }

  return (
    <AnthropicApiKeyFormView
      label={label}
      apiKey={apiKey}
      showKey={showKey}
      error={error}
      onLabelChange={setLabel}
      onApiKeyChange={(v) => {
        setApiKey(v)
        if (error) setError(null)
      }}
      onToggleShowKey={() => setShowKey((s) => !s)}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  )
}
