import { expect, it } from 'vitest'
import { RELAY_DURABLE_RESET_PREPARATION_CAPABILITY } from './relay-owner-reset-contract'
import {
  parseRelayResetPreparationBinding,
  readRelayResetPreparationBinding,
  validateRelayResetPreparationRecord
} from './relay-reset-preparation-contract'

const binding = parseRelayResetPreparationBinding({
  version: 1,
  journalDirectory: '/journal',
  principal: 'owner',
  authenticationKind: 'endpoint-credential',
  sockPath: '/socket',
  serverBuildId: 'build'
})
const request = {
  version: 1 as const,
  operationId: 'reset',
  runtimeIncarnation: 'runtime',
  ownerGeneration: 1,
  ownerLease: 'lease'
}
const record = {
  version: 1,
  prepared: true,
  request,
  principal: binding.principal,
  authenticationKind: binding.authenticationKind,
  sockPath: binding.sockPath,
  serverBuildId: binding.serverBuildId
}

it('does not infer durable recovery support from unnegotiated metadata', () => {
  expect(readRelayResetPreparationBinding({ ownerReset: { preparation: binding } })).toBeUndefined()
  expect(readRelayResetPreparationBinding({ capabilities: [] })).toBeUndefined()
})

it('requires valid metadata once durable preparation is advertised', () => {
  const capabilities = [RELAY_DURABLE_RESET_PREPARATION_CAPABILITY]
  expect(() => readRelayResetPreparationBinding({ capabilities })).toThrow('invalid')
  expect(
    readRelayResetPreparationBinding({ capabilities, ownerReset: { preparation: binding } })
  ).toEqual(binding)
})

it('validates exact preparation without adding an exit or cleanup verdict', () => {
  const result = validateRelayResetPreparationRecord(record, binding, request)
  expect(result).toEqual(record)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.request)).toBe(true)
})

it('preserves optional reader negotiation without assuming old hosts implement it', () => {
  expect(parseRelayResetPreparationBinding(binding).readerVersion).toBeUndefined()
  expect(parseRelayResetPreparationBinding({ ...binding, readerVersion: 1 }).readerVersion).toBe(1)
  expect(() => parseRelayResetPreparationBinding({ ...binding, readerVersion: 2 })).toThrow(
    'reader_version_invalid'
  )
})

it.each(['principal', 'authenticationKind', 'sockPath', 'serverBuildId'] as const)(
  'rejects changed %s evidence',
  (field) => {
    const value = field === 'authenticationKind' ? 'launch-nonce' : 'other'
    expect(() =>
      validateRelayResetPreparationRecord({ ...record, [field]: value }, binding, request)
    ).toThrow('conflict')
  }
)

it.each(['operationId', 'runtimeIncarnation', 'ownerGeneration', 'ownerLease'] as const)(
  'rejects a changed request %s',
  (field) => {
    const value = field === 'ownerGeneration' ? 2 : 'other'
    expect(() =>
      validateRelayResetPreparationRecord(
        { ...record, request: { ...request, [field]: value } },
        binding,
        request
      )
    ).toThrow('conflict')
  }
)

it.each(['', 'x\0y', 'x'.repeat(8193)])('refuses invalid journal directory', (journalDirectory) => {
  expect(() => parseRelayResetPreparationBinding({ ...binding, journalDirectory })).toThrow(
    'invalid'
  )
})
