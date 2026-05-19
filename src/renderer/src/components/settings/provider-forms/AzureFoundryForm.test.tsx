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
