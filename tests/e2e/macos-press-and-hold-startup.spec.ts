// #14746: verify startup resolves the real bundle id and records its decision; off macOS stays inert.
// CDP cannot prove physical held-key repeat: AppKit needs relaunch; real defaults-domain tests pin preference semantics.
// Unpackaged Electron must refuse its foreign domain because defaults uses real HOME despite fixture isolation.
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

type StartupState = {
  recordRaw: string | null
  bundleIdentifier: string | null
  execPath: string
}

async function readPressAndHoldStartupState(
  electronApp: ElectronApplication
): Promise<StartupState> {
  return electronApp.evaluate(({ app }) => {
    const nodeFs = process.getBuiltinModule('node:fs')
    const nodePath = process.getBuiltinModule('node:path')
    const recordPath = nodePath.join(app.getPath('userData'), 'macos-press-and-hold-default.json')
    const read = (file: string): string | null => {
      try {
        return nodeFs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    }
    // Derive the bundle id independently of product code for the startup cross-check.
    const plist = read(
      nodePath.join(nodePath.dirname(nodePath.dirname(process.execPath)), 'Info.plist')
    )
    const match = plist
      ? /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
      : null
    return {
      recordRaw: read(recordPath),
      bundleIdentifier: match ? match[1].trim() : null,
      execPath: process.execPath
    }
  })
}

test.describe('macOS press-and-hold default', () => {
  test.skip(process.platform !== 'darwin', 'macOS-only startup routine')

  test('records a decision for the bundle it is actually running from', async ({ electronApp }) => {
    const state = await readPressAndHoldStartupState(electronApp)

    expect(state.recordRaw, 'startup must leave a decision record').not.toBeNull()
    const record = JSON.parse(state.recordRaw!) as {
      version: number
      decision: string
      domain: string | null
    }

    expect(record.version).toBe(1)
    expect(state.bundleIdentifier).not.toBeNull()
    expect(record.domain).toBe(state.bundleIdentifier)

    const ownsDomain =
      record.domain === 'com.stablyai.orca' || record.domain!.startsWith('com.stablyai.orca.')
    if (ownsDomain) {
      // A packaged or dev-identity bundle: the write path is live and must have settled.
      expect(['applied', 'kept-user-preference']).toContain(record.decision)
    } else {
      // The unpackaged harness. Anything but a refusal means Orca wrote into a foreign domain.
      expect(record.decision).toBe('foreign-bundle')
    }
  })
})

test.describe('off macOS', () => {
  test.skip(process.platform === 'darwin', 'covers the non-macOS branch')

  test('writes nothing at all', async ({ electronApp }) => {
    const state = await readPressAndHoldStartupState(electronApp)

    expect(state.recordRaw).toBeNull()
  })
})
