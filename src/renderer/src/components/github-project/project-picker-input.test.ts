import { describe, expect, it } from 'vitest'
import { parseProjectInput } from './project-picker-input'

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

  it('rejects credentials and malformed Project routes', () => {
    for (const input of [
      'https://user:token@github.corp.example/orgs/acme/projects/7',
      'https://github.corp.example/orgs/acme/projects/7evil',
      'https://github.corp.example/orgs/acme/projects/7/views/2evil',
      'https://github.corp.example/orgs/acme/projects/7/files',
      'https://github.corp.example/orgs/_acme/projects/7',
      '_acme/7'
    ]) {
      expect(parseProjectInput(input)).toBeNull()
    }
  })
})
