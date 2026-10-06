import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stringify } from 'yaml'
import { EphemeralVmRecipeSshTargetSchema } from '../../../src/shared/ephemeral-vm-recipes'
import { runProcess } from '../../../src/shared/child-process/run-process'
import { shellQuote } from './docker-ssh-relay-target'

export const RECIPE_SSH_FIXTURE_ID = 'hidden-ssh-file-authority'

export function readRecipeSshFixtureTarget(fixturePath: string) {
  const raw: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected an explicitly supplied SSH fixture target')
  }
  const fields = Object.fromEntries(
    Object.entries(raw).filter(([key, value]) => key !== 'configHost' && value !== null)
  )
  return EphemeralVmRecipeSshTargetSchema.parse(fields)
}

type RecipeSshTarget = ReturnType<typeof readRecipeSshFixtureTarget>

export function recipeSshFixtureCommand(target: RecipeSshTarget, command: string) {
  return runProcess({
    program: process.env.ORCA_SSH_EXECUTABLE || 'ssh',
    args: [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-p',
      String(target.port),
      ...(target.identityFile ? ['-i', target.identityFile] : []),
      ...(target.identitiesOnly ? ['-o', 'IdentitiesOnly=yes'] : []),
      ...(target.identityAgent ? ['-o', `IdentityAgent=${target.identityAgent}`] : []),
      ...(target.proxyCommand ? ['-o', `ProxyCommand=${target.proxyCommand}`] : []),
      ...(target.jumpHost ? ['-J', target.jumpHost] : []),
      `${target.username}@${target.host}`,
      command
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024
  })
}

async function requireRecipeSshCommand(target: RecipeSshTarget, command: string): Promise<string> {
  const result = await recipeSshFixtureCommand(target, command)
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`SSH fixture command failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

export async function createRecipeSshFileFixture(target: RecipeSshTarget) {
  const platform = (await requireRecipeSshCommand(target, 'uname -s')).trim()
  if (platform !== 'Linux') {
    throw new Error('This opt-in fixture requires an explicitly supplied Linux SSH host')
  }
  const remoteRoot = path.posix.join('/tmp', `orca-g49-${randomUUID()}`)
  const filePath = path.posix.join(remoteRoot, 'authority.txt')
  await requireRecipeSshCommand(
    target,
    [
      `mkdir ${shellQuote(remoteRoot)}`,
      `printf 'Recipe fixture original\n' > ${shellQuote(filePath)}`,
      `git -C ${shellQuote(remoteRoot)} init -q`,
      `git -C ${shellQuote(remoteRoot)} add authority.txt`,
      `git -C ${shellQuote(remoteRoot)} -c user.name='Orca E2E' -c user.email='orca-e2e@example.invalid' commit -qm fixture`
    ].join(' && ')
  )
  return {
    remoteRoot,
    filePath,
    readFile: () => requireRecipeSshCommand(target, `cat ${shellQuote(filePath)}`),
    fileExists: async (name: string) => {
      const result = await recipeSshFixtureCommand(
        target,
        `test -f ${shellQuote(path.posix.join(remoteRoot, name))}`
      )
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(`SSH fixture file check is unverifiable: ${result.stderr}`)
      }
      return result.code === 0
    },
    cleanup: () =>
      requireRecipeSshCommand(target, `rm -rf -- ${shellQuote(remoteRoot)}`).then(() => {})
  }
}

export function writeRecipeSshFileFixtureRecipe(
  repoPath: string,
  target: RecipeSshTarget,
  remoteRoot: string
): void {
  writeFileSync(
    path.join(repoPath, 'recipe-create.mjs'),
    `console.log(${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        connection: { type: 'ssh', projectRoot: remoteRoot, target }
      })
    )})\n`
  )
  writeFileSync(path.join(repoPath, 'recipe-destroy.mjs'), 'process.stdin.resume()\n')
  writeFileSync(
    path.join(repoPath, 'orca.yaml'),
    stringify({
      environmentRecipes: [
        {
          id: RECIPE_SSH_FIXTURE_ID,
          name: 'Existing SSH file authority fixture',
          create: `${JSON.stringify(process.execPath)} ./recipe-create.mjs`,
          destroy: `${JSON.stringify(process.execPath)} ./recipe-destroy.mjs`
        }
      ]
    })
  )
}

export async function readRecipeSshFixtureKnownHost(target: RecipeSshTarget): Promise<string> {
  const hostKey = target.port === 22 ? target.host : `[${target.host}]:${target.port}`
  const result = await runProcess({
    program: process.env.ORCA_SSH_KEYGEN_EXECUTABLE || 'ssh-keygen',
    args: ['-F', hostKey],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  })
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error('SSH fixture must already have a trusted known_hosts entry')
  }
  return result.stdout
}
