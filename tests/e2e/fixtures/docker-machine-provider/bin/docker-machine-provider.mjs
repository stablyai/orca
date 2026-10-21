// E2E machine provider (protocolVersion 1). Each machine is a container of the Docker SSH host
// image, labelled with its id and create operationId; sleep stops it and wake starts it, which
// remaps its SSH port, so Orca's endpoint-change path runs. Configured by the spec through env:
// ORCA_E2E_MACHINE_IMAGE, ORCA_E2E_MACHINE_RUN_ID, ORCA_E2E_MACHINE_IDENTITY_FILE,
// ORCA_E2E_SSH_TARGET_HOST (defaults to 127.0.0.1), and optionally ORCA_E2E_MACHINE_PORT_RANGE.
// With DOCKER_HOST set to a remote engine, set ORCA_E2E_SSH_TARGET_HOST to that host's address.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECT_ROOT = '/root/work'
const ORIGIN_REPO = '/srv/orca-e2e-origin.git'
const SEED_ORIGIN = [
  `git init -q --bare -b main ${ORIGIN_REPO}`,
  `git clone -q ${ORIGIN_REPO} /tmp/origin-seed`,
  'printf "e2e\\n" > /tmp/origin-seed/README.md',
  'git -C /tmp/origin-seed add README.md',
  'git -C /tmp/origin-seed commit -qm initial',
  'git -C /tmp/origin-seed push -q origin HEAD:main'
].join(' && ')
const [verb, , , machineId] = process.argv.slice(2)
const runId = process.env.ORCA_E2E_MACHINE_RUN_ID ?? 'default'
const host = process.env.ORCA_E2E_SSH_TARGET_HOST?.trim() || '127.0.0.1'
const contextId = `docker:${runId}`
const request = JSON.parse(readFileSync(0, 'utf8') || '{}')
const label = (key) => `orca.e2e.machine.${key}`

// The app runs with an isolated HOME; docker keeps the developer's, so an ssh:// DOCKER_HOST still
// finds their ssh config and keys.
const dockerEnv = {
  ...process.env,
  HOME: process.env.ORCA_E2E_MACHINE_DOCKER_HOME || process.env.HOME
}

function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    env: dockerEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function respond(body, exitCode = 0) {
  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      operationId: request.operationId,
      contextId,
      now: new Date().toISOString(),
      ...body
    })
  )
  process.exitCode = exitCode
}

function containers() {
  const ids = docker('ps', '-aq', '--filter', `label=${label('run')}=${runId}`)
  return ids ? JSON.parse(docker('inspect', ...ids.split('\n'))) : []
}

function find(id) {
  return containers().find((container) => container.Config.Labels[label('id')] === id)
}

function view(container) {
  const labels = container.Config.Labels
  const running = container.State.Running
  const machine = {
    id: labels[label('id')],
    name: labels[label('name')],
    lifetime: labels[label('lifetime')],
    state: running ? 'running' : 'sleeping',
    createdAt: labels[label('createdAt')],
    creatingOperationId: labels[label('operationId')],
    detail: 'Docker SSH host',
    ...(labels[label('expiresAt')] ? { expiresAt: labels[label('expiresAt')] } : {})
  }
  if (!running) {
    return machine
  }
  const port = sshPort(container)
  // The comment field is dropped: Orca pins "<type> <base64>" only.
  const hostKey = docker('exec', container.Id, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub')
    .split(' ')
    .slice(0, 2)
    .join(' ')
  return {
    ...machine,
    access: {
      kind: 'ssh',
      host,
      port,
      user: 'root',
      projectRoot: PROJECT_ROOT,
      hostKeys: [hostKey]
    }
  }
}

// The e2e HOME starts with no SSH key; a real user's key would already be there.
function installClientKey() {
  const target = join(homedir(), '.ssh', 'id_ed25519')
  if (!existsSync(target)) {
    mkdirSync(join(homedir(), '.ssh'), { recursive: true, mode: 0o700 })
    copyFileSync(process.env.ORCA_E2E_MACHINE_IDENTITY_FILE, target)
    execFileSync('chmod', ['600', target])
  }
}

function create() {
  const existing = containers().find(
    (container) => container.Config.Labels[label('operationId')] === request.operationId
  )
  if (existing) {
    return respond({ kind: 'machine', machine: view(existing) })
  }
  installClientKey()
  process.stderr.write('starting docker machine\n')
  const params = request.params ?? {}
  const id = `dm-${randomUUID().slice(0, 8)}`
  const createdAt = new Date()
  const expiresAt =
    params.lifetime === 'temporary'
      ? new Date(createdAt.getTime() + (params.ttlSeconds ?? 3600) * 1000).toISOString()
      : ''
  const publicKey = readFileSync(`${process.env.ORCA_E2E_MACHINE_IDENTITY_FILE}.pub`, 'utf8').trim()
  const name = `orca-e2e-machine-${id}`
  const publish = publishArgs(name)
  docker(
    'run',
    '-d',
    '--name',
    name,
    ...publish.args,
    '--label',
    `${label('run')}=${runId}`,
    '--label',
    `${label('id')}=${id}`,
    '--label',
    `${label('name')}=${params.name ?? id}`,
    '--label',
    `${label('lifetime')}=${params.lifetime ?? 'persistent'}`,
    '--label',
    `${label('createdAt')}=${createdAt.toISOString()}`,
    '--label',
    `${label('expiresAt')}=${expiresAt}`,
    '--label',
    `${label('operationId')}=${request.operationId}`,
    '-e',
    `AUTHORIZED_KEY=${publicKey}`,
    process.env.ORCA_E2E_MACHINE_IMAGE,
    'bash',
    '-lc',
    [
      'printf "%s\\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys',
      'chmod 600 /root/.ssh/authorized_keys',
      `mkdir -p ${PROJECT_ROOT}`,
      'git config --global user.email e2e@test.local',
      'git config --global user.name "Orca Machine E2E"',
      // The UI journey's project clones from this origin over git://127.0.0.1/orca-e2e-origin.git.
      // Seeded once: a wake reruns this command in the same container.
      `[ -d ${ORIGIN_REPO} ] || { ${SEED_ORIGIN}; }`,
      'git daemon --reuseaddr --listen=127.0.0.1 --base-path=/srv --export-all --detach /srv',
      `exec /usr/sbin/sshd -D -e -p ${publish.sshdPort}`
    ].join(' && ')
  )
  process.stderr.write('docker machine running\n')
  respond({ kind: 'machine', machine: view(find(id)) })
}

// Docker-published ports by default. A remote engine whose firewall drops forwarded traffic
// (ufw with Docker) needs ports it accepts on the host itself, given as
// ORCA_E2E_MACHINE_PORT_RANGE="<first>-<last>": sshd then runs on the host network on one of them,
// so its port stays the same across wake.
const PORT_RANGE = process.env.ORCA_E2E_MACHINE_PORT_RANGE?.match(/^(\d+)-(\d+)$/)

function publishArgs(container) {
  if (!PORT_RANGE) {
    return { args: ['-p', `${host === '127.0.0.1' ? host : '0.0.0.0'}::22`], sshdPort: 22 }
  }
  const taken = new Set(
    docker(
      'ps',
      '-a',
      '--filter',
      `label=${label('port')}`,
      '--format',
      `{{.Label "${label('port')}"}}`
    )
      .split('\n')
      .filter(Boolean)
      .map(Number)
  )
  for (let port = Number(PORT_RANGE[1]); port <= Number(PORT_RANGE[2]); port++) {
    if (!taken.has(port)) {
      return { args: ['--network', 'host', '--label', `${label('port')}=${port}`], sshdPort: port }
    }
  }
  throw new Error(`no free port in ${process.env.ORCA_E2E_MACHINE_PORT_RANGE} for ${container}`)
}

function sshPort(container) {
  const fixed = container.Config.Labels[label('port')]
  return fixed
    ? Number(fixed)
    : Number(docker('port', container.Id, '22/tcp').split('\n')[0].split(':').at(-1))
}

function targeted(action) {
  const container = find(machineId)
  if (!container) {
    return respond({ kind: 'error', code: 'not-found', message: `no machine ${machineId}` }, 4)
  }
  return action(container)
}

switch (verb) {
  case 'capabilities':
    respond({
      kind: 'capabilities',
      capabilities: {
        verbs: ['create', 'get', 'sleep', 'wake', 'delete'],
        lifetimes: ['persistent', 'temporary'],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 86400,
        contextId,
        contextLabel: 'Docker (e2e)'
      }
    })
    break
  case 'list':
    respond({ kind: 'inventory', machines: containers().map(view) })
    break
  case 'create':
    create()
    break
  case 'get':
    targeted((container) => respond({ kind: 'machine', machine: view(container) }))
    break
  case 'sleep':
    targeted((container) => {
      docker('stop', '-t', '1', container.Id)
      respond({ kind: 'machine', machine: view(find(machineId)) })
    })
    break
  case 'wake':
    targeted((container) => {
      process.stderr.write('starting docker machine\n')
      docker('start', container.Id)
      respond({ kind: 'machine', machine: view(find(machineId)) })
    })
    break
  case 'delete':
    targeted((container) => {
      docker('rm', '-f', container.Id)
      respond({ kind: 'error', code: 'not-found', message: 'deleted' }, 4)
    })
    break
  default:
    respond({ kind: 'error', code: 'unsupported', message: `unknown verb ${verb}` }, 2)
}
