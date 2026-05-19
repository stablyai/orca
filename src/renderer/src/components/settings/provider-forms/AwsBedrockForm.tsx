import * as React from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import type { AddClaudeAccountInput } from '../../../../../shared/types'

export type AwsBedrockSubmit = Extract<AddClaudeAccountInput, { authMethod: 'aws-bedrock' }>

export type AwsBedrockBuilderInput = {
  label: string
  region: string
  secret: string
  inferenceProfilePrefix: string
}

// Why: keep the region list small and curated to match what Bedrock supports for
// Anthropic models — the handler will validate exact region/profile at probe time.
// `global` is a sentinel that maps to a system-wide inference profile.
export const BEDROCK_REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'global'
] as const

/**
 * Validate + build the submit payload for the AWS Bedrock form.
 *
 * Why: pure helper so tests can call it directly without rendering — the
 * renderer suite runs under `environment: 'node'` with no jsdom, so DOM-event
 * driven testing is not available. Empty/whitespace-only `secret` triggers
 * the IAM-chain path (no `secretFromUser` emitted), matching the handler's
 * runtime expectation.
 */
export function buildAwsBedrockSubmit(input: AwsBedrockBuilderInput): AwsBedrockSubmit {
  const region = input.region.trim()
  if (!region) {
    throw new Error('AWS region is required.')
  }
  const secret = input.secret.trim()
  const prefix = input.inferenceProfilePrefix.trim()
  const trimmedLabel = input.label.trim()
  const label = trimmedLabel === '' ? undefined : trimmedLabel
  const providerConfig: AwsBedrockSubmit['providerConfig'] = prefix
    ? { region, inferenceProfilePrefix: prefix }
    : { region }
  // IAM-chain path: omit secretFromUser entirely so consumers discriminate on
  // shape rather than truthiness — matches the type's optional secret field.
  if (!secret) {
    return { authMethod: 'aws-bedrock', label, providerConfig }
  }
  return {
    authMethod: 'aws-bedrock',
    label,
    secretFromUser: secret,
    providerConfig
  }
}

export type AwsBedrockFormViewProps = {
  label: string
  region: string
  secret: string
  inferenceProfilePrefix: string
  validation: { status: 'idle' | 'pending' | 'ok' | 'error'; message?: string }
  onLabelChange: (value: string) => void
  onRegionChange: (value: string) => void
  onSecretChange: (value: string) => void
  onInferenceProfilePrefixChange: (value: string) => void
  onValidate: () => void
  onSubmit: () => void
  onBack: () => void
}

/**
 * Stateless render of the AWS Bedrock form.
 *
 * Exported separately from `AwsBedrockForm` so tests can call this as a plain
 * function (no hook dispatcher) and traverse the returned element tree.
 */
export function AwsBedrockFormView({
  label,
  region,
  secret,
  inferenceProfilePrefix,
  validation,
  onLabelChange,
  onRegionChange,
  onSecretChange,
  onInferenceProfilePrefixChange,
  onValidate,
  onSubmit,
  onBack
}: AwsBedrockFormViewProps): React.JSX.Element {
  const errorMessage = validation.status === 'error' ? validation.message : undefined
  return (
    <form
      aria-label="AWS Bedrock provider form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="abr-label">Label (optional)</Label>
        <Input
          id="abr-label"
          aria-label="Label"
          autoFocus
          placeholder="e.g. Bedrock prod"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="abr-region">AWS Region</Label>
        {/* Why: native <select> over Radix Select — renderer tests run under
            `environment: 'node'` without jsdom, so portal-rendered Radix
            primitives don't surface in static markup. Native select renders
            inline and traversable. */}
        <select
          id="abr-region"
          aria-label="AWS Region"
          value={region}
          onChange={(e) => onRegionChange(e.target.value)}
          className="flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <option value="" disabled>
            Choose region
          </option>
          {BEDROCK_REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="abr-token">Bearer Token (optional)</Label>
        <Input
          id="abr-token"
          aria-label="Bearer Token"
          type="password"
          placeholder="Leave empty to use the AWS IAM credential chain"
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
          aria-invalid={errorMessage ? true : undefined}
        />
        <p className="text-xs text-muted-foreground">
          Leave empty to use the AWS IAM credential chain (env vars, profile, or instance role).
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="abr-prefix">Inference profile prefix (advanced)</Label>
        <Input
          id="abr-prefix"
          aria-label="Inference profile prefix"
          placeholder="auto — derived from region"
          value={inferenceProfilePrefix}
          onChange={(e) => onInferenceProfilePrefixChange(e.target.value)}
        />
      </div>
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

export type AwsBedrockFormProps = {
  onSubmit: (input: AwsBedrockSubmit) => void
  onBack: () => void
  onValidate: (input: AwsBedrockSubmit) => Promise<{ ok: boolean; message?: string }>
}

export function AwsBedrockForm({
  onSubmit,
  onBack,
  onValidate
}: AwsBedrockFormProps): React.JSX.Element {
  const [label, setLabel] = React.useState('')
  const [region, setRegion] = React.useState('')
  const [secret, setSecret] = React.useState('')
  const [prefix, setPrefix] = React.useState('')
  const [validation, setValidation] = React.useState<AwsBedrockFormViewProps['validation']>({
    status: 'idle'
  })

  function handleSubmit(): void {
    try {
      onSubmit(buildAwsBedrockSubmit({ label, region, secret, inferenceProfilePrefix: prefix }))
    } catch (error) {
      setValidation({ status: 'error', message: (error as Error).message })
    }
  }

  async function handleValidate(): Promise<void> {
    try {
      const input = buildAwsBedrockSubmit({
        label,
        region,
        secret,
        inferenceProfilePrefix: prefix
      })
      setValidation({ status: 'pending' })
      const result = await onValidate(input)
      setValidation(result.ok ? { status: 'ok' } : { status: 'error', message: result.message })
    } catch (error) {
      setValidation({ status: 'error', message: (error as Error).message })
    }
  }

  return (
    <AwsBedrockFormView
      label={label}
      region={region}
      secret={secret}
      inferenceProfilePrefix={prefix}
      validation={validation}
      onLabelChange={setLabel}
      onRegionChange={setRegion}
      onSecretChange={setSecret}
      onInferenceProfilePrefixChange={setPrefix}
      onValidate={handleValidate}
      onSubmit={handleSubmit}
      onBack={onBack}
    />
  )
}

export default AwsBedrockForm
