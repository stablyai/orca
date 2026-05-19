import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AwsBedrockFormView,
  buildAwsBedrockSubmit,
  type AwsBedrockFormViewProps
} from './AwsBedrockForm'

// Why: renderer suite runs under `environment: 'node'` with no jsdom — we
// exercise the pure builder directly and traverse the stateless view tree
// instead of using @testing-library/react. Mirrors the AzureFoundryForm
// convention.

describe('buildAwsBedrockSubmit — static bearer token path', () => {
  it('produces the wire shape with region + token', () => {
    const submit = buildAwsBedrockSubmit({
      label: 'Bedrock prod',
      region: 'us-east-1',
      secret: 'bearer-xyz',
      inferenceProfilePrefix: ''
    })
    expect(submit).toEqual({
      authMethod: 'aws-bedrock',
      label: 'Bedrock prod',
      secretFromUser: 'bearer-xyz',
      providerConfig: { region: 'us-east-1' }
    })
  })

  it('omits label when blank, trims whitespace', () => {
    const submit = buildAwsBedrockSubmit({
      label: '   ',
      region: 'us-west-2',
      secret: '  bearer  ',
      inferenceProfilePrefix: ''
    })
    expect(submit.label).toBeUndefined()
    expect(submit.secretFromUser).toBe('bearer')
  })

  it('rejects empty region', () => {
    expect(() =>
      buildAwsBedrockSubmit({
        label: '',
        region: '',
        secret: 'bearer',
        inferenceProfilePrefix: ''
      })
    ).toThrow(/region/i)
  })

  it('includes inferenceProfilePrefix when provided', () => {
    const submit = buildAwsBedrockSubmit({
      label: '',
      region: 'eu-west-1',
      secret: 'bearer',
      inferenceProfilePrefix: 'eu.'
    })
    expect(submit.providerConfig).toEqual({
      region: 'eu-west-1',
      inferenceProfilePrefix: 'eu.'
    })
  })
})

describe('buildAwsBedrockSubmit — IAM-chain (empty token) path', () => {
  it('produces a submit without secretFromUser when token is empty', () => {
    const submit = buildAwsBedrockSubmit({
      label: 'Bedrock dev',
      region: 'eu-west-1',
      secret: '',
      inferenceProfilePrefix: ''
    })
    expect(submit).toEqual({
      authMethod: 'aws-bedrock',
      label: 'Bedrock dev',
      providerConfig: { region: 'eu-west-1' }
    })
    expect('secretFromUser' in submit).toBe(false)
  })

  it('whitespace-only token is treated as empty (IAM-chain path)', () => {
    const submit = buildAwsBedrockSubmit({
      label: '',
      region: 'us-east-1',
      secret: '   ',
      inferenceProfilePrefix: ''
    })
    expect('secretFromUser' in submit).toBe(false)
  })

  it('still requires region on IAM-chain path', () => {
    expect(() =>
      buildAwsBedrockSubmit({
        label: '',
        region: '',
        secret: '',
        inferenceProfilePrefix: ''
      })
    ).toThrow(/region/i)
  })
})

function renderView(
  overrides: Partial<AwsBedrockFormViewProps> = {}
): React.JSX.Element {
  return AwsBedrockFormView({
    label: '',
    region: '',
    secret: '',
    inferenceProfilePrefix: '',
    validation: { status: 'idle' },
    onLabelChange: () => {},
    onRegionChange: () => {},
    onSecretChange: () => {},
    onInferenceProfilePrefixChange: () => {},
    onValidate: () => {},
    onSubmit: () => {},
    onBack: () => {},
    ...overrides
  })
}

describe('AwsBedrockFormView markup', () => {
  it('renders region select, bearer-token input, inference-profile override input', () => {
    const markup = renderToStaticMarkup(renderView())
    expect(markup).toMatch(/AWS Region/i)
    expect(markup).toMatch(/Bearer Token/i)
    expect(markup).toMatch(/inference profile/i)
  })

  it('surfaces a hint that an empty token falls back to the AWS IAM chain', () => {
    const markup = renderToStaticMarkup(renderView())
    expect(markup).toMatch(/IAM/i)
  })

  it('surfaces a validation error when validation.status is error', () => {
    const markup = renderToStaticMarkup(
      renderView({
        validation: { status: 'error', message: 'Locked credentials. Refresh IAM session.' }
      })
    )
    expect(markup).toMatch(/Locked credentials/)
  })
})
