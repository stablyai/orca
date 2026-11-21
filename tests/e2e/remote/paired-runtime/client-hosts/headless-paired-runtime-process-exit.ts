import type { ElectronApplication } from '@stablyai/playwright-test'
import { getElectronProcessForE2E } from '../../../desktop/electron-fixtures/electron-process-handle'
import {
  formatHeadlessPairedRuntimeStartupDiagnostics,
  HeadlessPairedRuntimeStartupDiagnosticBuffer
} from './headless-paired-runtime-serve-readiness'

export function observeHeadlessPairedRuntimeProcessExit(app: ElectronApplication): () => void {
  const child = getElectronProcessForE2E(app)
  const stdout = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
  const stderr = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
  let stopped = false
  const onStdout = (chunk: Buffer): void => stdout.append(chunk)
  const onStderr = (chunk: Buffer): void => stderr.append(chunk)
  const stop = (): void => {
    stopped = true
    child.stdout?.off('data', onStdout)
    child.stderr?.off('data', onStderr)
    child.off('exit', onExit)
  }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (stopped) {
      return
    }
    stop()
    console.error(
      '[headless-runtime-exit]',
      JSON.stringify({ pid: child.pid, code, signal }),
      formatHeadlessPairedRuntimeStartupDiagnostics(stdout.read(), stderr.read())
    )
  }
  child.stdout?.on('data', onStdout)
  child.stderr?.on('data', onStderr)
  child.once('exit', onExit)
  if (child.exitCode !== null || child.signalCode !== null) {
    onExit(child.exitCode, child.signalCode)
  }
  return stop
}
