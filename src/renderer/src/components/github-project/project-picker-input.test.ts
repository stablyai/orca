import { describe, expect, it } from 'vitest'
import { getProjectPickerBrowseHost, parseProjectInput } from './ProjectPicker'

describe('ProjectPicker project input', () => {
  it('preserves the host and custom port from a GHES project URL', () => {
    expect(
      parseProjectInput('https://github.corp.example:8443/orgs/acme/projects/7/views/2')
    ).toEqual({
      owner: 'acme',
      number: 7,
      host: 'github.corp.example:8443',
      viewNumber: 2
    })
  })

  it('keeps owner/number shorthand on the default host', () => {
    expect(parseProjectInput('acme/7')).toEqual({ owner: 'acme', number: 7 })
  })

  it('browses and reports auth errors against the active project host', () => {
    expect(getProjectPickerBrowseHost({ host: ' GitHub.Corp.Example:8443 ' })).toBe(
      'github.corp.example:8443'
    )
    expect(getProjectPickerBrowseHost(null)).toBe('github.com')
  })

  it('rejects credentials and malformed Project routes', () => {
    for (const input of [
      'https://user:token@github.corp.example/orgs/acme/projects/7',
      'https://github.corp.example/orgs/acme/projects/7evil',
      'https://github.corp.example/orgs/acme/projects/7/views/2evil',
      'https://github.corp.example/orgs/acme/projects/7/files',
      'https://github.corp.example/orgs/co_op/projects/7'
    ]) {
      expect(parseProjectInput(input)).toBeNull()
    }
  })
})
