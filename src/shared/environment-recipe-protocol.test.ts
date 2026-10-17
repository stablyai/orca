import { describe, expect, it } from 'vitest'
import {
  environmentRecipeRequestSchema,
  environmentRecipeResourceSchema,
  environmentRecipeResponseSchema,
  parseEnvironmentRecipeResponse,
  type EnvironmentRecipeRequest
} from './environment-recipe-protocol'

const request: EnvironmentRecipeRequest = {
  protocolVersion: 1,
  operationId: '12345678-1234-4234-8234-123456789abc',
  providerId: 'internal.devpods',
  action: 'resume',
  resourceId: 'my-pod',
  expectedRevision: 'r1'
}
const resource = {
  id: 'my-pod',
  name: 'Development pod',
  revision: 'r2',
  lifetime: 'long-lived',
  state: 'running',
  connection: {
    type: 'ssh',
    host: 'pod.internal',
    username: 'developer',
    port: 22,
    projectRoot: '/workspace'
  }
}
const response = {
  protocolVersion: 1,
  operationId: request.operationId,
  providerId: request.providerId,
  action: 'resume',
  kind: 'resource',
  resource
}

describe('environment recipe lifecycle protocol', () => {
  it('accepts a revision-bound long-lived SSH wake response', () => {
    expect(parseEnvironmentRecipeResponse(JSON.stringify(response), request)).toEqual(response)
  })
  it.each(['delete', 'sleep', 'resume', 'archive'])(
    'requires identity and revision for %s',
    (action) => {
      expect(environmentRecipeRequestSchema.safeParse({ ...request, action }).success).toBe(true)
      expect(
        environmentRecipeRequestSchema.safeParse({
          ...request,
          action,
          expectedRevision: undefined
        }).success
      ).toBe(false)
    }
  )
  it.each(['operationId', 'providerId', 'action'])('rejects a response for another %s', (field) => {
    const changed = {
      ...response,
      [field]:
        field === 'operationId'
          ? '12345678-1234-4234-8234-123456789abd'
          : field === 'action'
            ? 'create'
            : 'other.devpods'
    }
    expect(() => parseEnvironmentRecipeResponse(JSON.stringify(changed), request)).toThrow(
      'this operation'
    )
  })
  it('rejects another resource, unconfirmed transitions and late create results during delete', () => {
    expect(() =>
      parseEnvironmentRecipeResponse(
        JSON.stringify({ ...response, resource: { ...resource, id: 'someone-elses-pod' } }),
        request
      )
    ).toThrow('another resource')
    expect(() =>
      parseEnvironmentRecipeResponse(
        JSON.stringify({
          ...response,
          resource: { ...resource, state: 'sleeping', connection: undefined }
        }),
        request
      )
    ).toThrow('transition')
    const deletion = environmentRecipeRequestSchema.parse({ ...request, action: 'delete' })
    expect(() =>
      parseEnvironmentRecipeResponse(JSON.stringify({ ...response, action: 'delete' }), deletion)
    ).toThrow('transition')
  })
  it('keeps list read-only and refuses duplicate inventory or credentials', () => {
    const inventory = {
      ...response,
      action: 'list',
      kind: 'inventory',
      resources: [resource],
      resource: undefined
    }
    const { resource: omitted, ...valid } = inventory
    expect(omitted).toBeUndefined()
    expect(environmentRecipeResponseSchema.safeParse(valid).success).toBe(true)
    expect(
      environmentRecipeResponseSchema.safeParse({ ...valid, resources: [resource, resource] })
        .success
    ).toBe(false)
    expect(
      environmentRecipeResourceSchema.safeParse({
        ...resource,
        connection: { ...resource.connection, password: 'secret' }
      }).success
    ).toBe(false)
    expect(
      environmentRecipeResourceSchema.safeParse({
        ...resource,
        connection: { ...resource.connection, proxyCommand: 'run something' }
      }).success
    ).toBe(false)
  })
  it('bounds raw output and refuses nested JSON before interpreting it', () => {
    expect(() => parseEnvironmentRecipeResponse(' '.repeat(512 * 1024 + 1), request)).toThrow(
      'byte limit'
    )
    expect(() =>
      parseEnvironmentRecipeResponse(`${'['.repeat(20)}0${']'.repeat(20)}`, request)
    ).toThrow('nesting')
    expect(() =>
      parseEnvironmentRecipeResponse(`log line\n${JSON.stringify(response)}`, request)
    ).toThrow()
  })
  it('does not mint an SSH connection for stopped or unverifiable resources', () => {
    for (const state of ['sleeping', 'archived', 'deleted', 'unknown']) {
      expect(environmentRecipeResourceSchema.safeParse({ ...resource, state }).success).toBe(false)
      expect(
        environmentRecipeResourceSchema.safeParse({ ...resource, state, connection: undefined })
          .success
      ).toBe(true)
    }
  })
})
