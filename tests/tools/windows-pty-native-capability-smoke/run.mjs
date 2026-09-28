import { build } from 'esbuild'
import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertPackagedBunCapability } from './packaged-bun-capability-oracle.mjs'

const EVIDENCE_PREFIX = 'ORCA_BUN_PTY_CAPABILITY_EVIDENCE='
const PROBE_TIMEOUT_MS = 45_000
const MAX_DIAGNOSTIC_CHARS = 8_000

function executableArgument(argv) {
  const value = argv.find((arg) => arg.startsWith('--exe='))?.slice('--exe='.length)
  if (!value) {
    throw new Error('usage: windows-pty-native-capability-smoke --exe=<packaged Orca.exe>')
  }
  return path.resolve(value)
}

export function checkoutRunProcessPath() {
  return path.resolve(import.meta.dirname, '../../../out/shared/child-process/run-process.js')
}

export function packagedProbeInvocation(executable, adapterPath, environment = process.env) {
  const resolvedExecutable = path.resolve(executable)
  const resourcesDir = path.join(path.dirname(resolvedExecutable), 'resources')
  const probe = path.join(import.meta.dirname, 'packaged-bun-capability-probe.cjs')
  return {
    program: path.join(resourcesDir, 'cli-runtime', 'bun-runtime.exe'),
    args: [
      '--no-env-file',
      `--config=${path.join(path.dirname(adapterPath), 'bunfig.toml')}`,
      probe,
      '--exercise',
      resourcesDir,
      process.execPath,
      adapterPath
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(environment).filter(
          ([key]) =>
            ![
              'ELECTRON_RUN_AS_NODE',
              'NODE_OPTIONS',
              'NODE_PATH',
              'BUN_OPTIONS',
              'BUN_INSPECT'
            ].includes(key.toUpperCase())
        )
      ),
      ORCA_BACKGROUND_LAUNCH: '1',
      BUN_CONPTY_LIBRARY: path.join(resourcesDir, 'cli-runtime', 'conpty', 'conpty.dll')
    },
    timeoutMs: PROBE_TIMEOUT_MS
  }
}

function diagnosticTail(value) {
  return value.length <= MAX_DIAGNOSTIC_CHARS ? value : value.slice(-MAX_DIAGNOSTIC_CHARS)
}

export function formatProbeFailure(result) {
  return [
    `packaged native capability probe failed (code=${result.code}, timedOut=${result.timedOut})`,
    `stdout:\n${diagnosticTail(result.stdout) || '<empty>'}`,
    `stderr:\n${diagnosticTail(result.stderr) || '<empty>'}`
  ].join('\n')
}

function parseEvidence(stdout) {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(EVIDENCE_PREFIX))
  if (!line) {
    throw new Error(`packaged probe did not emit ${EVIDENCE_PREFIX}`)
  }
  return JSON.parse(line.slice(EVIDENCE_PREFIX.length))
}

export async function buildCapabilityAdapter(directory, resources) {
  const adapterPath = path.join(directory, 'capability-adapter.cjs')
  const root = path.resolve(import.meta.dirname, '../../..')
  await build({
    stdin: {
      contents:
        "export { spawnBunPty } from './src/main/daemon/pty-subprocess/bun-pty-process'; export { spawnProcess, runProcess } from './src/shared/child-process/run-process'",
      resolveDir: root,
      loader: 'ts'
    },
    outfile: adapterPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['bun:ffi', 'electron'],
    logLevel: 'silent'
  })
  await copyFile(
    path.join(resources, 'terminal-daemon', 'windows-bun-pty-gate-entry.js'),
    path.join(directory, 'windows-bun-pty-gate-entry.js')
  )
  await writeFile(path.join(directory, 'bunfig.toml'), '')
  return adapterPath
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('windows-pty-native-capability-smoke requires a physical Windows host')
  }
  const executable = executableArgument(process.argv.slice(2))
  const require = createRequire(import.meta.url)
  const { runProcess } = require(checkoutRunProcessPath())
  const resources = path.join(path.dirname(executable), 'resources')
  const { verifyCliRuntimeDirectory } = require('../../../config/bundled-cli-runtime.cjs')
  verifyCliRuntimeDirectory(path.join(resources, 'cli-runtime'), 'win32', process.arch)
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-packaged-bun-capability-'))
  try {
    const adapterPath = await buildCapabilityAdapter(directory, resources)
    const result = await runProcess(packagedProbeInvocation(executable, adapterPath))
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(formatProbeFailure(result))
    }
    assertPackagedBunCapability(parseEvidence(result.stdout))
    process.stdout.write(`[windows-pty-native-capability-smoke] PASS ${executable}\n`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
