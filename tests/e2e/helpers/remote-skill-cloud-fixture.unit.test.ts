import { expect, it, vi } from 'vitest'
import {
  REMOTE_SKILL_PACKAGE_ID,
  REMOTE_SKILL_VERSION_ID,
  startRemoteSkillCloudFixture,
  stopRemoteSkillCloudFixture
} from './remote-skill-cloud-fixture'

it('serves concurrent skill fixtures from independent bound origins', async () => {
  vi.stubEnv('ORCA_E2E_SKILL_CLOUD_PORT', undefined)
  const results = await Promise.allSettled([
    startRemoteSkillCloudFixture(),
    startRemoteSkillCloudFixture()
  ])
  const fixtures = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )
  try {
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(new Set(fixtures.map((fixture) => fixture.origin)).size).toBe(2)
    for (const fixture of fixtures) {
      const response = await fetch(
        `${fixture.origin}/v1/skill-packages/${REMOTE_SKILL_PACKAGE_ID}/versions/${REMOTE_SKILL_VERSION_ID}/download-grants`,
        {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' }
        }
      )
      expect(response.status).toBe(200)
      const result = (await response.json()) as { grant: { url: string } }
      expect(result.grant.url).toBe(`${fixture.origin}/package.tar.gz`)
      const archive = await fetch(result.grant.url)
      expect(Buffer.from(await archive.arrayBuffer())).toEqual(fixture.bytes)
      expect(fixture.requests).toHaveLength(2)
    }
  } finally {
    await Promise.all(fixtures.map(stopRemoteSkillCloudFixture))
    vi.unstubAllEnvs()
  }
})
