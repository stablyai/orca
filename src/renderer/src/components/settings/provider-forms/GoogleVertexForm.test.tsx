import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  GoogleVertexFormView,
  buildGoogleVertexSubmit,
  type GoogleVertexFormViewProps
} from './GoogleVertexForm'

// Why: renderer suite runs under `environment: 'node'` with no jsdom — we
// exercise the pure builder directly and traverse the stateless view tree.
// Mirrors AzureFoundryForm / AwsBedrockForm.

describe('buildGoogleVertexSubmit', () => {
  it('produces the wire shape with projectId + region; no secret field', () => {
    const submit = buildGoogleVertexSubmit({
      label: 'Vertex prod',
      projectId: 'my-gcp',
      region: 'us-east5'
    })
    expect(submit).toEqual({
      authMethod: 'google-vertex',
      label: 'Vertex prod',
      providerConfig: { projectId: 'my-gcp', region: 'us-east5' }
    })
    // Why: Vertex is ADC-only — we never store a token, the form must not emit one.
    expect('secretFromUser' in submit).toBe(false)
  })

  it('omits label when blank, trims whitespace', () => {
    const submit = buildGoogleVertexSubmit({
      label: '   ',
      projectId: '  my-gcp  ',
      region: 'global'
    })
    expect(submit.label).toBeUndefined()
    expect(submit.providerConfig.projectId).toBe('my-gcp')
  })

  it('rejects empty projectId', () => {
    expect(() =>
      buildGoogleVertexSubmit({
        label: '',
        projectId: '',
        region: 'us-east5'
      })
    ).toThrow(/project/i)
  })

  it('rejects empty region', () => {
    expect(() =>
      buildGoogleVertexSubmit({
        label: '',
        projectId: 'p',
        region: ''
      })
    ).toThrow(/region/i)
  })
})

function renderView(
  overrides: Partial<GoogleVertexFormViewProps> = {}
): React.JSX.Element {
  return GoogleVertexFormView({
    label: '',
    projectId: '',
    region: 'us-east5',
    validation: { status: 'idle' },
    onLabelChange: () => {},
    onProjectIdChange: () => {},
    onRegionChange: () => {},
    onValidate: () => {},
    onSubmit: () => {},
    onBack: () => {},
    ...overrides
  })
}

describe('GoogleVertexFormView markup', () => {
  it('renders projectId + region; no secret/token input', () => {
    const markup = renderToStaticMarkup(renderView())
    expect(markup).toMatch(/Project ID/i)
    expect(markup).toMatch(/Region/i)
    expect(markup).not.toMatch(/Token|Secret|API key|Bearer/i)
  })

  it('points users at gcloud ADC setup', () => {
    const markup = renderToStaticMarkup(renderView())
    expect(markup).toMatch(/gcloud auth application-default login/)
  })

  it('surfaces a validation error when validation.status is error', () => {
    const markup = renderToStaticMarkup(
      renderView({
        validation: { status: 'error', message: 'gcloud ADC not found.' }
      })
    )
    expect(markup).toMatch(/gcloud ADC not found/)
  })

  it('offers the two supported regions (us-east5 + global)', () => {
    const markup = renderToStaticMarkup(renderView())
    expect(markup).toMatch(/us-east5/)
    expect(markup).toMatch(/global/)
  })
})
