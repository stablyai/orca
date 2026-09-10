import path from 'node:path'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../src/shared/protocol-version'

export const CODEX_COORDINATOR_LIVE = 'MWC_CODEX_COORDINATOR_LIVE'

export function buildCodexCoordinatorSource(
  dir: string,
  cliRoot: string,
  userDataDir: string
): string {
  return `#!/usr/bin/env node
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { readMetadata } = require(${JSON.stringify(path.join(cliRoot, 'runtime', 'metadata.js'))})
const { sendRequest } = require(${JSON.stringify(path.join(cliRoot, 'runtime', 'transport.js'))})
const dir = ${JSON.stringify(dir)}
const evidence = { terminalHandle: process.env.ORCA_TERMINAL_HANDLE, paneKey: process.env.ORCA_PANE_KEY, launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN }
const claimed = new Set()
setInterval(() => {
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('-request.json')) continue
    const label = entry.slice(0, -'-request.json'.length)
    if (claimed.has(label) || existsSync(join(dir, label + '-result.json'))) continue
    claimed.add(label)
    try {
      const request = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
      const orchestrationEnvelope = request.method.startsWith('orchestration.') ? {
        orchestrationContractVersion: ${ORCHESTRATION_CONTRACT_VERSION},
        orchestrationRequestId: randomUUID()
      } : {}
      sendRequest(readMetadata(${JSON.stringify(userDataDir)}), request.method, request.params, 30000, {
        ...orchestrationEnvelope,
        compatibilityInvocationId: randomUUID(),
        orchestrationCompatibilityEvidence: evidence
      }).then((response) => writeFileSync(join(dir, label + '-result.json'), JSON.stringify(response)))
        .catch((error) => writeFileSync(join(dir, label + '-result.json'), JSON.stringify({ ok: false, error: String(error) })))
    } catch (error) { writeFileSync(join(dir, label + '-result.json'), JSON.stringify({ ok: false, error: String(error) })) }
  }
}, 100)
writeFileSync(join(dir, 'coordinator-live.json'), JSON.stringify({
  pid: process.pid,
  terminalHandle: process.env.ORCA_TERMINAL_HANDLE,
  paneKey: process.env.ORCA_PANE_KEY,
  launchTokenPresent: Boolean(process.env.ORCA_AGENT_LAUNCH_TOKEN)
}))
process.stdout.write('MWC_CODEX_COORDINATOR_READY\\n')
setTimeout(() => process.stdout.write(${JSON.stringify(CODEX_COORDINATOR_LIVE)} + '\\n'), 250)
process.stdin.resume()
`
}
