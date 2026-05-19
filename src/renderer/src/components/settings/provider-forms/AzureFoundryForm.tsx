import * as React from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import type { AddClaudeAccountInput } from '../../../../../shared/types'

export type AzureFoundryTab = 'api-key' | 'entra-id'

export type AzureFoundrySubmit = Extract<AddClaudeAccountInput, { authMethod: 'azure-foundry' }>

export type AzureFoundryBuilderInput = {
  tab: AzureFoundryTab
  label: string
  resource: string
  apiKey: string
}

/**
 * Validate + build the submit payload for the Azure Foundry form.
 *
 * Pure helper so tests can call it directly without rendering — the renderer
 * test suite runs under `environment: 'node'` with no jsdom, so DOM-event
 * driven testing is not available.
 */
export function buildAzureFoundrySubmit(input: AzureFoundryBuilderInput): AzureFoundrySubmit {
  const resource = input.resource.trim()
  if (!resource) throw new Error('Azure Foundry resource name is required.')
  const trimmedLabel = input.label.trim()
  const label = trimmedLabel === '' ? undefined : trimmedLabel
  if (input.tab === 'api-key') {
    const apiKey = input.apiKey.trim()
    if (!apiKey) throw new Error('Azure Foundry API key is required.')
    return {
      authMethod: 'azure-foundry',
      label,
      secretFromUser: apiKey,
      providerConfig: { resource, useEntraId: false }
    }
  }
  // Entra ID path — no secretFromUser; omitted so consumers can detect path via
  // discriminator-shape narrowing rather than truthiness checks.
  return {
    authMethod: 'azure-foundry',
    label,
    providerConfig: { resource, useEntraId: true }
  }
}

export type AzureFoundryFormViewProps = {
  tab: AzureFoundryTab
  label: string
  resource: string
  apiKey: string
  useEntraId: boolean
  validation: { status: 'idle' | 'pending' | 'ok' | 'error'; message?: string }
  onTabChange: (tab: AzureFoundryTab) => void
  onLabelChange: (value: string) => void
  onResourceChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onValidate: () => void
  onSubmit: () => void
  onBack: () => void
}

/**
 * Stateless render of the Azure Foundry form.
 *
 * Exported separately from `AzureFoundryForm` so tests can call this as a
 * plain function (no hook dispatcher) and traverse the returned element tree.
 */
export function AzureFoundryFormView({
  tab,
  label,
  resource,
  apiKey,
  validation,
  onTabChange,
  onLabelChange,
  onResourceChange,
  onApiKeyChange,
  onValidate,
  onSubmit,
  onBack
}: AzureFoundryFormViewProps): React.JSX.Element {
  const errorMessage = validation.status === 'error' ? validation.message : undefined
  return (
    <form
      aria-label="Azure Foundry provider form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-3"
    >
      <div role="tablist" aria-label="Foundry auth method" className="flex flex-wrap gap-1">
        <Button
          type="button"
          role="tab"
          aria-selected={tab === 'api-key'}
          variant={tab === 'api-key' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onTabChange('api-key')}
        >
          API key
        </Button>
        <Button
          type="button"
          role="tab"
          aria-selected={tab === 'entra-id'}
          variant={tab === 'entra-id' ? 'default' : 'outline'}
          size="sm"
          onClick={() => onTabChange('entra-id')}
        >
          Entra ID
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="afy-label">Label (optional)</Label>
        <Input
          id="afy-label"
          aria-label="Label"
          autoFocus
          placeholder="e.g. Foundry prod"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="afy-resource">Resource</Label>
        <Input
          id="afy-resource"
          aria-label="Resource"
          placeholder="my-foundry-resource"
          value={resource}
          onChange={(e) => onResourceChange(e.target.value)}
        />
      </div>
      {tab === 'api-key' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="afy-apikey">API key</Label>
          <Input
            id="afy-apikey"
            aria-label="API key"
            type="password"
            placeholder="Foundry API key"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? 'afy-apikey-error' : undefined}
          />
        </div>
      )}
      {tab === 'entra-id' && (
        <p className="text-sm text-muted-foreground">
          Make sure you&apos;ve run <code>az login</code>. Orca verifies the sign-in when you click
          Validate.
        </p>
      )}
      {errorMessage ? (
        <p id="afy-apikey-error" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}
      <div className="flex justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack} aria-label="Back">
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onValidate}
            disabled={validation.status === 'pending'}
          >
            {validation.status === 'pending' ? 'Validating…' : 'Validate'}
          </Button>
          <Button type="submit" aria-label="Add account">
            Add account
          </Button>
        </div>
      </div>
    </form>
  )
}

export type AzureFoundryFormProps = {
  onSubmit: (input: AzureFoundrySubmit) => void
  onBack: () => void
  onValidate: (input: AzureFoundrySubmit) => Promise<{ ok: boolean; message?: string }>
}

export function AzureFoundryForm({
  onSubmit,
  onBack,
  onValidate
}: AzureFoundryFormProps): React.JSX.Element {
  const [tab, setTab] = React.useState<AzureFoundryTab>('api-key')
  const [label, setLabel] = React.useState('')
  const [resource, setResource] = React.useState('')
  const [apiKey, setApiKey] = React.useState('')
  const [validation, setValidation] = React.useState<AzureFoundryFormViewProps['validation']>({
    status: 'idle'
  })

  function handleSubmit(): void {
    try {
      onSubmit(buildAzureFoundrySubmit({ tab, label, resource, apiKey }))
    } catch (error) {
      setValidation({ status: 'error', message: (error as Error).message })
    }
  }

  async function handleValidate(): Promise<void> {
    try {
      const input = buildAzureFoundrySubmit({ tab, label, resource, apiKey })
      setValidation({ status: 'pending' })
      const result = await onValidate(input)
      setValidation(result.ok ? { status: 'ok' } : { status: 'error', message: result.message })
    } catch (error) {
      setValidation({ status: 'error', message: (error as Error).message })
    }
  }

  return (
    <AzureFoundryFormView
      tab={tab}
      label={label}
      resource={resource}
      apiKey={apiKey}
      useEntraId={tab === 'entra-id'}
      validation={validation}
      onTabChange={setTab}
      onLabelChange={setLabel}
      onResourceChange={setResource}
      onApiKeyChange={setApiKey}
      onValidate={handleValidate}
      onSubmit={handleSubmit}
      onBack={onBack}
    />
  )
}
