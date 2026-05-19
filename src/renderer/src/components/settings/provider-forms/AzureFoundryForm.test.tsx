import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AzureFoundryFormView, buildAzureFoundrySubmit } from './AzureFoundryForm'

describe('buildAzureFoundrySubmit — API key tab', () => {
  it('produces the API-key shape', () => {
    const submit = buildAzureFoundrySubmit({
      tab: 'api-key',
      label: 'Foundry prod',
      resource: 'prod-resource',
      apiKey: 'fkey-abc'
    })
    expect(submit).toEqual({
      authMethod: 'azure-foundry',
      label: 'Foundry prod',
      secretFromUser: 'fkey-abc',
      providerConfig: { resource: 'prod-resource', useEntraId: false }
    })
  })

  it('rejects empty resource', () => {
    expect(() =>
      buildAzureFoundrySubmit({
        tab: 'api-key',
        label: 'F',
        resource: '',
        apiKey: 'k'
      })
    ).toThrow(/resource/i)
  })

  it('rejects empty api key on api-key tab', () => {
    expect(() =>
      buildAzureFoundrySubmit({
        tab: 'api-key',
        label: 'F',
        resource: 'r',
        apiKey: ''
      })
    ).toThrow(/api key/i)
  })
})

describe('AzureFoundryFormView markup — API key tab', () => {
  it('renders resource + api-key inputs', () => {
    const markup = renderToStaticMarkup(
      <AzureFoundryFormView
        tab="api-key"
        label=""
        resource=""
        apiKey=""
        useEntraId={false}
        validation={{ status: 'idle' }}
        onLabelChange={() => {}}
        onResourceChange={() => {}}
        onApiKeyChange={() => {}}
        onTabChange={() => {}}
        onValidate={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />
    )
    expect(markup).toMatch(/aria-label="Resource"/)
    expect(markup).toMatch(/aria-label="API key"/)
    expect(markup).not.toMatch(/aria-label="Use Entra ID"/) // hidden on api-key tab
  })
})

describe('buildAzureFoundrySubmit — Entra ID tab', () => {
  it('omits secretFromUser, sets useEntraId true', () => {
    const submit = buildAzureFoundrySubmit({
      tab: 'entra-id',
      label: 'Foundry dev',
      resource: 'dev-resource',
      apiKey: '' // ignored on entra-id tab
    })
    expect(submit).toEqual({
      authMethod: 'azure-foundry',
      label: 'Foundry dev',
      providerConfig: { resource: 'dev-resource', useEntraId: true }
    })
    expect('secretFromUser' in submit).toBe(false)
  })

  it('still requires resource on entra-id tab', () => {
    expect(() =>
      buildAzureFoundrySubmit({
        tab: 'entra-id',
        label: 'F',
        resource: '',
        apiKey: ''
      })
    ).toThrow(/resource/i)
  })
})

describe('AzureFoundryFormView markup — Entra ID tab', () => {
  it('hides apiKey input and surfaces az login hint', () => {
    const markup = renderToStaticMarkup(
      <AzureFoundryFormView
        tab="entra-id"
        label=""
        resource=""
        apiKey=""
        useEntraId
        validation={{ status: 'idle' }}
        onLabelChange={() => {}}
        onResourceChange={() => {}}
        onApiKeyChange={() => {}}
        onTabChange={() => {}}
        onValidate={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />
    )
    expect(markup).not.toMatch(/aria-label="API key"/)
    expect(markup).toMatch(/az login/)
  })
})
