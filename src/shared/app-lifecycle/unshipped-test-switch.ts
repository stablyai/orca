import { getAppEnvironment, hasAppEnvironment } from './app-environment'

/** A test-only env switch: honored in tests and unpackaged dev builds, never in a shipped build. */
export function unshippedTestSwitchOn(name: string): boolean {
  if (hasAppEnvironment() && getAppEnvironment().isPackaged()) {
    return false
  }
  return typeof process !== 'undefined' && process.env?.[name] === '1'
}
