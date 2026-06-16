import { describe, expect, it } from 'vitest'
import { buildDockerContainerGroups } from './docker-container-groups'
import type { DockerContainerSummary } from '../../../../shared/docker-types'

function c(over: Partial<DockerContainerSummary> & { id: string }): DockerContainerSummary {
  return { names: [over.id], image: 'img', state: 'running', status: '', ...over }
}

describe('buildDockerContainerGroups', () => {
  it('groups by project then service, sorted, and separates standalone', () => {
    const result = buildDockerContainerGroups([
      c({ id: 'solo', names: ['solo'] }),
      c({ id: 'shop-web-1', names: ['shop-web-1'], composeProject: 'shop', composeService: 'web' }),
      c({ id: 'shop-web-2', names: ['shop-web-2'], composeProject: 'shop', composeService: 'web' }),
      c({ id: 'shop-db-1', names: ['shop-db-1'], composeProject: 'shop', composeService: 'db' }),
      c({ id: 'app-api-1', names: ['app-api-1'], composeProject: 'app', composeService: 'api' })
    ])
    expect(result.standalone.map((x) => x.id)).toEqual(['solo'])
    expect(result.composeProjects.map((p) => p.project)).toEqual(['app', 'shop'])
    const shop = result.composeProjects.find((p) => p.project === 'shop')!
    expect(shop.services.map((s) => s.service)).toEqual(['db', 'web'])
    expect(shop.services.find((s) => s.service === 'web')!.containers.map((x) => x.id)).toEqual([
      'shop-web-1',
      'shop-web-2'
    ])
  })

  it('puts project containers without a service into an empty-named service group', () => {
    const result = buildDockerContainerGroups([
      c({ id: 'p1', names: ['p1'], composeProject: 'proj' })
    ])
    const proj = result.composeProjects.find((p) => p.project === 'proj')!
    expect(proj.services.map((s) => s.service)).toEqual([''])
    expect(proj.services[0].containers.map((x) => x.id)).toEqual(['p1'])
  })
})
