import type { SshConnection } from '../../../src/main/ssh/ssh-connection'
import { execCommand } from '../../../src/main/ssh/ssh-relay-deploy-helpers'
import { tunneledOrcadPairingCode } from '../../../src/main/ssh/orcad-tunneled-pairing'
import type { ServeReadiness } from '../../../src/main/server/serve-readiness'
import { decodePairingOffer } from '../../../src/shared/pairing'
import { sendRemoteRuntimeRequest } from '../../../src/shared/remote-runtime-client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../src/shared/protocol-version'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../../src/shared/pty-ownership-transfer-release-gate'
import { shellQuote as q } from './docker-ssh-relay-target'

export function createLiveCatalogSshDestination(options: {
  connection: SshConnection
  directory: string
  artifactDirectory: string
  remotePort: number
  localPort: number
}) {
  const { directory, artifactDirectory, remotePort } = options
  let { connection, localPort } = options
  const entry = `${artifactDirectory}/orcad.js`
  const log = `${directory}/stdout.log`
  let pid: string | undefined
  let diagnostics = ''
  let pairing: ReturnType<typeof decodePairingOffer> | undefined
  let readiness: ServeReadiness | undefined
  const execute = (command: string) => execCommand(connection, command, { timeoutMs: 10_000 })
  return {
    diagnostics: () => diagnostics,
    rebindTransport(nextConnection: SshConnection, nextLocalPort: number) {
      if (!readiness) {
        throw new Error('fixture_remote_orcad_not_started')
      }
      const nextPairing = decodePairingOffer(tunneledOrcadPairingCode(readiness, nextLocalPort))
      connection = nextConnection
      localPort = nextLocalPort
      pairing = nextPairing
    },
    async start() {
      if (pid) {
        throw new Error('fixture_remote_orcad_already_running')
      }
      const startedPid = (
        await execute(
          [
            `mkdir -p ${q(`${directory}/home`)}`,
            `cd ${q(directory)}`,
            `nohup env HOME=${q(`${directory}/home`)} ORCA_USER_DATA=${q(`${directory}/data`)} ORCA_BACKGROUND_LAUNCH=1 ORCA_TEST_MOCK_KEYCHAIN=1 ${PTY_OWNERSHIP_TRANSFER_CANARY_ENV}=1 ${q(`${artifactDirectory}/bun-runtime`)} ${q(entry)} --bind 127.0.0.1 --port ${remotePort} --json > ${q(log)} 2>&1 < /dev/null & echo $!`
          ].join('\n')
        )
      ).trim()
      if (!/^[1-9][0-9]*$/.test(startedPid)) {
        throw new Error('fixture_remote_orcad_pid_invalid')
      }
      pid = startedPid
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline) {
        diagnostics = await execute(`tail -c 32768 ${q(log)}`)
        for (const line of diagnostics.split('\n')) {
          let message: ServeReadiness & { type?: string }
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.type !== 'orca_server_ready') {
            continue
          }
          const url = tunneledOrcadPairingCode(message, localPort)
          pairing = decodePairingOffer(url)
          readiness = message
          return { runtimeId: message.runtimeId, pairing: { url } }
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      throw new Error(`fixture_remote_orcad_readiness_timeout: ${diagnostics}`)
    },
    async stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
      if (!pid) {
        return
      }
      // Exact argv identity is checked on the owning host before signaling this fixture PID.
      await execute(
        `if [ -r /proc/${pid}/cmdline ]; then tr '\\0' '\\n' < /proc/${pid}/cmdline | grep -Fx -- ${q(entry)} >/dev/null && kill -${signal === 'SIGKILL' ? 'KILL' : 'TERM'} ${pid}; fi`
      )
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const state = await execute(
          `if [ -r /proc/${pid}/stat ]; then awk '{print $3}' /proc/${pid}/stat; else printf exited; fi`
        )
        if (state.trim() === 'exited' || state.trim() === 'Z') {
          pid = undefined
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('fixture_remote_orcad_stop_unverifiable')
    },
    async rpc(method: string, params: unknown) {
      if (!pairing) {
        throw new Error('fixture_remote_orcad_not_started')
      }
      const result = await sendRemoteRuntimeRequest(
        pairing,
        method,
        params,
        30_000,
        undefined,
        undefined,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
      if (!result.ok) {
        throw new Error(`${method}: ${result.error.message}`)
      }
      return result.result
    }
  }
}
