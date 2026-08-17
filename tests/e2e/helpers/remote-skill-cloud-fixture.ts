import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSkillPackageArchive,
  type CreatedSkillPackage
} from '../../../src/main/skills/skill-package-creation'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../../src/shared/skill-package-manifest'

export const REMOTE_SKILL_CLOUD_PORT = Number(process.env.ORCA_E2E_SKILL_CLOUD_PORT ?? '43961')
export const REMOTE_SKILL_CLOUD_ORIGIN = `http://127.0.0.1:${REMOTE_SKILL_CLOUD_PORT}`
export const REMOTE_SKILL_PACKAGE_ID = 'package_remote_e2e'
export const REMOTE_SKILL_VERSION_ID = 'version_remote_e2e'
export const REMOTE_SKILL_NAME = 'remote-e2e-skill'

export type RemoteSkillCloudFixture = {
  archive: CreatedSkillPackage
  bytes: Buffer
  requests: { method: string; path: string; body: unknown }[]
  root: string
  server: Server
}

export async function startRemoteSkillCloudFixture(): Promise<RemoteSkillCloudFixture> {
  const root = await mkdtemp(join(tmpdir(), 'orca-remote-skill-cloud-'))
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: remote-e2e-skill\ndescription: Remote installation integration\n---\n\n# Remote E2E\n'
  )
  const archive = await createSkillPackageArchive({
    sourceDirectory: source,
    archivePath: join(root, 'package.tar.gz'),
    packageId: REMOTE_SKILL_PACKAGE_ID,
    versionId: REMOTE_SKILL_VERSION_ID,
    createdAt: '2026-08-11T12:00:00.000Z'
  })
  const bytes = await readFile(archive.archivePath)
  const requests: RemoteSkillCloudFixture['requests'] = []
  const server = createServer((request, response) => {
    void handleRemoteSkillCloudRequest({ request, response, archive, bytes, requests }).catch(
      (error) => {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 'fixture_failed', message: String(error) }))
      }
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(REMOTE_SKILL_CLOUD_PORT, '127.0.0.1', resolve)
  })
  return { archive, bytes, requests, root, server }
}

export async function stopRemoteSkillCloudFixture(fixture: RemoteSkillCloudFixture): Promise<void> {
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  await rm(fixture.root, { recursive: true, force: true })
}

async function handleRemoteSkillCloudRequest(input: {
  request: IncomingMessage
  response: ServerResponse
  archive: CreatedSkillPackage
  bytes: Buffer
  requests: RemoteSkillCloudFixture['requests']
}): Promise<void> {
  const path = new URL(input.request.url ?? '/', REMOTE_SKILL_CLOUD_ORIGIN).pathname
  if (input.request.method === 'GET' && path === '/package.tar.gz') {
    input.requests.push({ method: 'GET', path, body: null })
    input.response.writeHead(200, {
      'content-type': SKILL_PACKAGE_CONTENT_TYPE,
      'content-length': input.bytes.length
    })
    input.response.end(input.bytes)
    return
  }
  if (
    input.request.method === 'POST' &&
    path ===
      `/v1/skill-packages/${REMOTE_SKILL_PACKAGE_ID}/versions/${REMOTE_SKILL_VERSION_ID}/download-grants`
  ) {
    const body = JSON.parse(await readRequestBody(input.request)) as unknown
    input.requests.push({ method: 'POST', path, body })
    input.response.writeHead(200, { 'content-type': 'application/json' })
    input.response.end(JSON.stringify(downloadGrant(input.archive, input.bytes.length)))
    return
  }
  input.response.writeHead(404, { 'content-type': 'application/json' })
  input.response.end(JSON.stringify({ code: 'not_found', message: 'Not found' }))
}

function downloadGrant(archive: CreatedSkillPackage, compressedBytes: number) {
  return {
    grant: {
      url: `${REMOTE_SKILL_CLOUD_ORIGIN}/package.tar.gz`,
      expiresAt: '2099-01-01T00:00:00.000Z'
    },
    version: {
      packageId: REMOTE_SKILL_PACKAGE_ID,
      versionId: REMOTE_SKILL_VERSION_ID,
      name: REMOTE_SKILL_NAME,
      description: 'Remote installation integration',
      packageDigest: archive.manifest.packageDigest,
      archiveSha256: archive.archiveSha256,
      compressedBytes,
      createdAt: archive.manifest.createdAt,
      releaseNotes: 'E2E',
      manifest: archive.manifest
    }
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
