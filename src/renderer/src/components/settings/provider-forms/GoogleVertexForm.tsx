import * as React from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import type { AddClaudeAccountInput } from '../../../../../shared/types'

export type GoogleVertexSubmit = Extract<
  AddClaudeAccountInput,
  { authMethod: 'google-vertex' }
>

export type GoogleVertexBuilderInput = {
  label: string
  projectId: string
  region: string
}

// Why: Anthropic Claude on Vertex AI is currently published in `us-east5` and the
// system-wide `global` profile. Keep this list small; the handler validates
// exact projectId/region at probe time via gcloud ADC.
export const VERTEX_REGIONS = ['us-east5', 'global'] as const

/**
 * Validate + build the submit payload for the Google Vertex form.
 *
 * Why: Vertex is ADC-only — we never collect a secret. The renderer omits
 * `secretFromUser` entirely so the IPC pathway can short-circuit Keychain
 * writes (see service.buildCredentialsFromInput).
 *
 * Pure helper exported so tests can call it directly without rendering — the
 * renderer suite runs under `environment: 'node'` with no jsdom.
 */
export function buildGoogleVertexSubmit(
  input: GoogleVertexBuilderInput
): GoogleVertexSubmit {
  const projectId = input.projectId.trim()
  if (!projectId) {
    throw new Error('Google Cloud project ID is required.')
  }
  const region = input.region.trim()
  if (!region) {
    throw new Error('Vertex region is required.')
  }
  const trimmedLabel = input.label.trim()
  const label = trimmedLabel === '' ? undefined : trimmedLabel
  return {
    authMethod: 'google-vertex',
    label,
    providerConfig: { projectId, region }
  }
}

export type GoogleVertexFormViewProps = {
  label: string
  projectId: string
  region: string
  validation: { status: 'idle' | 'pending' | 'ok' | 'error'; message?: string }
  onLabelChange: (value: string) => void
  onProjectIdChange: (value: string) => void
  onRegionChange: (value: string) => void
  onValidate: () => void
  onSubmit: () => void
  onBack: () => void
}

/**
 * Stateless render of the Google Vertex form.
 *
 * Mirrors `AwsBedrockFormView` shape, minus the secret/IAM-prefix inputs. No
 * Bedrock-style token: Vertex auth is provided by `gcloud` Application Default
 * Credentials at CLI launch time.
 */
export function GoogleVertexFormView({
  label,
  projectId,
  region,
  validation,
  onLabelChange,
  onProjectIdChange,
  onRegionChange,
  onValidate,
  onSubmit,
  onBack
}: GoogleVertexFormViewProps): React.JSX.Element {
  const errorMessage = validation.status === 'error' ? validation.message : undefined
  return (
    <form
      aria-label="Google Vertex provider form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="gvx-label">Label (optional)</Label>
        <Input
          id="gvx-label"
          aria-label="Label"
          autoFocus
          placeholder="e.g. Vertex prod"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gvx-project">Project ID</Label>
        <Input
          id="gvx-project"
          aria-label="Project ID"
          placeholder="my-gcp-project"
          value={projectId}
          onChange={(e) => onProjectIdChange(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="gvx-region">Region</Label>
        {/* Why: native <select> — Radix Select renders through a portal which is
            invisible to the renderer test suite (no jsdom). */}
        <select
          id="gvx-region"
          aria-label="Region"
          value={region}
          onChange={(e) => onRegionChange(e.target.value)}
          className="flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {VERTEX_REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Vertex uses Google Cloud Application Default Credentials. Run{' '}
        <code className="font-mono text-[11px]">gcloud auth application-default login</code>{' '}
        before launching Orca so the Claude CLI can pick up your gcloud identity.
      </p>
      {errorMessage ? (
        <p className="text-xs text-destructive" role="alert">
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

export type GoogleVertexFormProps = {
  onSubmit: (input: GoogleVertexSubmit) => void
  onBack: () => void
  onValidate: (input: GoogleVertexSubmit) => Promise<{ ok: boolean; message?: string }>
}

export function GoogleVertexForm({
  onSubmit,
  onBack,
  onValidate
}: GoogleVertexFormProps): React.JSX.Element {
  const [label, setLabel] = React.useState('')
  const [projectId, setProjectId] = React.useState('')
  const [region, setRegion] = React.useState<string>('us-east5')
  const [validation, setValidation] = React.useState<
    GoogleVertexFormViewProps['validation']
  >({ status: 'idle' })

  function handleSubmit(): void {
    try {
      onSubmit(buildGoogleVertexSubmit({ label, projectId, region }))
    } catch (error) {
      setValidation({ status: 'error', message: (error as Error).message })
    }
  }

  async function handleValidate(): Promise<void> {
    try {
      const input = buildGoogleVertexSubmit({ label, projectId, region })
      setValidation({ status: 'pending' })
      const result = await onValidate(input)
      setValidation(result.ok ? { status: 'ok' } : { status: 'error', message: result.message })
    } catch (error) {
      setValidation({ status: 'error', message: (error as Error).message })
    }
  }

  return (
    <GoogleVertexFormView
      label={label}
      projectId={projectId}
      region={region}
      validation={validation}
      onLabelChange={setLabel}
      onProjectIdChange={setProjectId}
      onRegionChange={setRegion}
      onValidate={handleValidate}
      onSubmit={handleSubmit}
      onBack={onBack}
    />
  )
}

export default GoogleVertexForm
