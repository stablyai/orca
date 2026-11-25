import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { earlyAppProfileUserData } from './app-profile-env-core'
import { appProfilesRoot, readAppProfileMarker } from './app-profile-paths'
import { resolveAppProfile } from '../../main/app-profiles/app-profile'
import { createAppProfileHomesBanner } from '../../../config/build-plugins/app-profile-homes-banner'

let home: string
let work: string
let other: string

function profileFolder(root: string, id: string): string {
  const folder = join(root, id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'orca-app-profile.json'), JSON.stringify({ id }))
  return folder
}

// A temp folder stands for the user's home; the code under test gets it through `io`.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-profile-env-core-'))
  work = profileFolder(join(home, 'Orca Profiles'), 'work')
  other = profileFolder(join(home, 'Orca Profiles'), 'other')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const io = () => ({ readFileSync, homedir: () => home })

function bundle(plistExtra: string): string {
  const app = join(home, 'Apps', 'Work.app', 'Contents')
  mkdirSync(join(app, 'MacOS'), { recursive: true })
  writeFileSync(
    join(app, 'Info.plist'),
    `<plist><dict><key>CFBundleExecutable</key><string>Orca</string>${plistExtra}</dict></plist>`
  )
  return join(app, 'MacOS', 'Orca')
}

const profilePlist = (root?: string) =>
  `<key>OrcaAppProfileId</key><string>work</string>${
    root ? `<key>OrcaAppProfilesRoot</key><string>${root}</string>` : ''
  }`

describe('the early app profile lookup', () => {
  it("finds the profile's folder from the bundle or from the marker in --user-data-dir", () => {
    const profileExe = bundle(profilePlist(join(home, 'Orca Profiles')))
    expect(earlyAppProfileUserData(io(), profileExe, [], {})).toBe(work)
    expect(earlyAppProfileUserData(io(), profileExe, [`--user-data-dir=${work}`], {})).toBe(work)
    // A folder that is not this profile's: no folders; the preflight then stops.
    expect(earlyAppProfileUserData(io(), profileExe, [`--user-data-dir=${other}`], {})).toBeNull()
    expect(earlyAppProfileUserData(io(), profileExe, [`--user-data-dir=${home}`], {})).toBeNull()
    const defaultExe = bundle('')
    expect(earlyAppProfileUserData(io(), defaultExe, [`--user-data-dir=${work}`], {})).toBe(work)
    expect(earlyAppProfileUserData(io(), defaultExe, [], {})).toBeNull()
  })

  it('gives the same folder as resolveAppProfile in every case', () => {
    const testRoot = join(home, 'test-root')
    const testWork = profileFolder(testRoot, 'work')
    const cases: { plist: string; argv: string[]; env: NodeJS.ProcessEnv }[] = []
    for (const plist of [
      profilePlist(join(home, 'Orca Profiles')),
      profilePlist(),
      profilePlist(join(home, 'O&amp;P &apos;x&apos;')),
      ''
    ]) {
      for (const argv of [[], [`--user-data-dir=${work}`], [`--user-data-dir=${other}`]]) {
        for (const env of [{}, { ORCA_PROFILES_ROOT: testRoot }]) {
          cases.push({ plist, argv, env })
        }
      }
    }
    for (const { plist, argv, env } of cases) {
      const executable = bundle(plist)
      let expected: string | null
      try {
        expected =
          resolveAppProfile({
            plist: readFileSync(join(executable, '..', '..', 'Info.plist'), 'utf8'),
            userDataDirArg: argv[0]?.slice('--user-data-dir='.length) ?? null,
            defaultRoot: appProfilesRoot(env, home),
            readMarker: readAppProfileMarker
          })?.userDataPath ?? null
      } catch {
        expected = null
      }
      expect({
        plist,
        argv,
        env,
        folder: earlyAppProfileUserData(io(), executable, argv, env)
      }).toEqual({ plist, argv, env, folder: expected })
    }
    // The env root case is in the table: the profile takes the test root's folder.
    expect(
      earlyAppProfileUserData(io(), bundle(profilePlist()), [], { ORCA_PROFILES_ROOT: testRoot })
    ).toBe(testWork)
  })
})

describe('the main bundle banner', () => {
  it('runs as standalone code and sets the folders before any module', () => {
    const executable = bundle(profilePlist(join(home, 'Orca Profiles')))
    const env: Record<string, string> = { GROK_HOME: '/user/grok' }
    const fakeProcess = {
      platform: 'darwin',
      versions: { electron: '43.0.0' },
      defaultApp: undefined,
      execPath: executable,
      argv: [executable],
      env
    }
    const fakeRequire = (name: string): unknown =>
      name === 'node:fs' ? { readFileSync } : { homedir: () => home }
    runInNewContext(createAppProfileHomesBanner(), { process: fakeProcess, require: fakeRequire })
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(work, 'orca-home', 'agents', 'claude'))
    expect(env.ORCA_HOME_DIR).toBe(join(work, 'orca-home'))
    // A profile replaces a value that the user set.
    expect(env.GROK_HOME).toBe(join(work, 'orca-home', 'agents', 'grok'))
  })

  it("clears a profile's folders that an unpackaged app inherits", () => {
    const env: Record<string, string> = {
      ORCA_HOME_DIR: join(work, 'orca-home'),
      CODEX_HOME: join(work, 'orca-home', 'agents', 'codex'),
      GROK_HOME: '/user/grok'
    }
    const fakeProcess = {
      platform: 'darwin',
      versions: { electron: '43.0.0' },
      defaultApp: true,
      execPath: '/dev/electron',
      argv: ['/dev/electron', '.'],
      env
    }
    const fakeRequire = (name: string): unknown =>
      name === 'node:fs' ? { readFileSync } : { homedir: () => home }
    runInNewContext(createAppProfileHomesBanner(), { process: fakeProcess, require: fakeRequire })
    expect(env).toEqual({ GROK_HOME: '/user/grok' })
  })
})
