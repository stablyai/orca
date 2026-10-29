import type { ElectronApplication } from '@stablyai/playwright-test'
import type { RuntimeDesktopPairingOffer } from './paired-electron-client'

type ServeReady = {
  type?: unknown
  pairing?: {
    available?: unknown
    url?: unknown
    webClientUrl?: unknown
  }
}

const STARTUP_DIAGNOSTIC_LIMIT = 8_000
const PAIRING_URL_PATTERN = /orca:\/\/[^\s"\\]+/g
const WEB_CLIENT_PAIRING_PATTERN = /([#&]pairing=)[^&\s"\\]+/g

export class HeadlessPairedRuntimeStartupDiagnosticBuffer {
  private completed = ''
  private discardingOversizedLine = false
  private pending = ''

  append(chunk: Buffer): void {
    let value = chunk.toString()
    if (this.discardingOversizedLine) {
      const newlineIndex = value.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      value = value.slice(newlineIndex + 1)
      this.discardingOversizedLine = false
    }

    const combined = `${this.pending}${value}`
    const newlineIndex = combined.lastIndexOf('\n')
    if (newlineIndex !== -1) {
      this.completed = `${this.completed}${redactPairingMaterial(
        combined.slice(0, newlineIndex + 1)
      )}`.slice(-STARTUP_DIAGNOSTIC_LIMIT)
      this.pending = combined.slice(newlineIndex + 1)
    } else {
      this.pending = combined
    }
    if (this.pending.length > STARTUP_DIAGNOSTIC_LIMIT) {
      this.pending = ''
      this.discardingOversizedLine = true
    }
  }

  read(): string {
    const pending = this.discardingOversizedLine ? '' : redactPairingMaterial(this.pending)
    return `${this.completed}${pending}`.slice(-STARTUP_DIAGNOSTIC_LIMIT)
  }
}

export function formatHeadlessPairedRuntimeStartupDiagnostics(
  stdout: string,
  stderr: string
): string {
  return [
    stdout ? `stdout:\n${redactPairingMaterial(stdout)}` : '',
    stderr ? `stderr:\n${redactPairingMaterial(stderr)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export function parseHeadlessPairedRuntimePairingOffer(
  line: string
): RuntimeDesktopPairingOffer | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null
  }
  const readiness = parsed as ServeReady
  const pairing = readiness.pairing
  if (
    readiness.type !== 'orca_server_ready' ||
    pairing?.available !== true ||
    typeof pairing.url !== 'string'
  ) {
    return null
  }
  return {
    pairingUrl: pairing.url,
    ...(typeof pairing.webClientUrl === 'string' ? { webClientUrl: pairing.webClientUrl } : {})
  }
}

/** True for the `orca_server_ready` line, whether or not it carries a pairing offer. */
export function isHeadlessPairedRuntimeServeReadyLine(line: string): boolean {
  try {
    return (JSON.parse(line) as ServeReady | null)?.type === 'orca_server_ready'
  } catch {
    return false
  }
}

function redactPairingMaterial(value: string): string {
  return value
    .replace(PAIRING_URL_PATTERN, 'orca://[redacted]')
    .replace(WEB_CLIENT_PAIRING_PATTERN, '$1[redacted]')
}

export async function readPairingOffer(
  app: ElectronApplication
): Promise<RuntimeDesktopPairingOffer> {
  const offer = await readServeReadiness(app, { requirePairingOffer: true })
  if (!offer) {
    throw new Error('Headless runtime published readiness without a pairing offer')
  }
  return offer
}

export async function readServeReadiness(
  app: ElectronApplication,
  options: { requirePairingOffer: boolean }
): Promise<RuntimeDesktopPairingOffer | null> {
  const child = app.process()
  const stdout = child.stdout
  if (!stdout) {
    throw new Error('Headless runtime stdout is unavailable')
  }
  return new Promise((resolve, reject) => {
    let buffered = ''
    const stdoutDiagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
    const stderrDiagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
    const stderr = child.stderr
    const timeout = setTimeout(() => {
      cleanup()
      const diagnostics = formatHeadlessPairedRuntimeStartupDiagnostics(
        stdoutDiagnostic.read(),
        stderrDiagnostic.read()
      )
      reject(
        new Error(
          `Headless runtime did not publish pairing readiness${diagnostics ? `\n${diagnostics}` : ''}`
        )
      )
    }, 60_000)
    const cleanup = (): void => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      stderr?.off('data', onStderr)
      child.off('close', onClose)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      const diagnostics = formatHeadlessPairedRuntimeStartupDiagnostics(
        stdoutDiagnostic.read(),
        stderrDiagnostic.read()
      )
      reject(
        new Error(
          `Headless runtime exited before pairing readiness (code=${code ?? 'none'}, signal=${signal ?? 'none'})${diagnostics ? `\n${diagnostics}` : ''}`
        )
      )
    }
    const onStderr = (chunk: Buffer): void => {
      stderrDiagnostic.append(chunk)
    }
    const onData = (chunk: Buffer): void => {
      stdoutDiagnostic.append(chunk)
      buffered += chunk.toString()
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const offer = parseHeadlessPairedRuntimePairingOffer(line)
        if (!offer) {
          if (options.requirePairingOffer || !isHeadlessPairedRuntimeServeReadyLine(line)) {
            continue
          }
          cleanup()
          resolve(null)
          return
        }
        cleanup()
        resolve(offer)
        return
      }
    }
    stdout.on('data', onData)
    stderr?.on('data', onStderr)
    child.on('close', onClose)
    if (child.exitCode !== null || child.signalCode !== null) {
      onClose(child.exitCode, child.signalCode)
    }
  })
}
