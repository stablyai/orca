import { describe, expect, it } from 'vitest'
import { renderSupervisorService } from './supervisor-service-render'
import {
  readConfiguredEndpoint,
  readExecTarget,
  readPinnedUserData,
  splitSystemdCommandLine,
  type SupervisorServiceFile
} from './supervisor-service-file-read'

function unit(overrides: { userDataPath?: string; nodePath?: string; orcadPath?: string } = {}) {
  const text = renderSupervisorService({
    platform: 'systemd',
    scope: 'system',
    nodePath: overrides.nodePath ?? '/usr/local/bin/node',
    orcadPath: overrides.orcadPath ?? '/opt/orcad/orcad.js',
    userDataPath: overrides.userDataPath ?? '/home/orca/.orca',
    user: 'orca',
    bind: '127.0.0.1',
    port: 6800
  })
  return {
    path: '/etc/systemd/system/orcad.service',
    text,
    platform: 'systemd',
    scope: 'system'
  } satisfies SupervisorServiceFile
}

// The generator quotes any value carrying a space, so a reader that splits on whitespace
// misreads the file this tool itself wrote — and then reports a healthy unit as pointing at
// a binary that is not there.
describe('reading back what the generator wrote', () => {
  const spaced = {
    userDataPath: '/Volumes/My Disk/.orca',
    nodePath: '/opt/my node/bin/node',
    orcadPath: '/opt/my orcad/orcad.js'
  }

  it('reads a spaced data root as one path', () => {
    expect(readPinnedUserData(unit(spaced))).toBe('/Volumes/My Disk/.orca')
  })

  it('reads a spaced interpreter and script as two words, not four', () => {
    expect(readExecTarget(unit(spaced))).toEqual({
      interpreter: '/opt/my node/bin/node',
      script: '/opt/my orcad/orcad.js'
    })
  })

  it('still finds the endpoint past a quoted interpreter', () => {
    expect(readConfiguredEndpoint(unit(spaced))).toEqual({ bind: '127.0.0.1', port: 6800 })
  })

  it('leaves an ordinary unit reading exactly as before', () => {
    expect(readPinnedUserData(unit())).toBe('/home/orca/.orca')
    expect(readExecTarget(unit())).toEqual({
      interpreter: '/usr/local/bin/node',
      script: '/opt/orcad/orcad.js'
    })
  })
})

// The plist half of the same rule. The generator XML-escapes every value it writes, so a
// reader that does not decode compares `/srv/a&amp;b` against the caller's `/srv/a&b` and
// calls the generator's own output a mismatched data root — or stats an ExecStart path that
// was never on disk and reports a healthy job as unable to start.
describe('reading back what the generator wrote to a plist', () => {
  const hostile = {
    userDataPath: '/Volumes/a&b/<orca>',
    nodePath: '/opt/n&de/bin/node',
    orcadPath: '/opt/orc&d/orcad.js'
  }

  function plist(overrides: typeof hostile): SupervisorServiceFile {
    return {
      path: '/Library/LaunchDaemons/dev.onorca.orcad.plist',
      text: renderSupervisorService({
        platform: 'launchd',
        scope: 'system',
        nodePath: overrides.nodePath,
        orcadPath: overrides.orcadPath,
        userDataPath: overrides.userDataPath,
        user: 'orca',
        bind: '127.0.0.1',
        port: 6800,
        logPath: '/var/log/orcad.log'
      }),
      platform: 'launchd',
      scope: 'system'
    }
  }

  it('decodes the escaped data root back to the path on disk', () => {
    expect(readPinnedUserData(plist(hostile))).toBe('/Volumes/a&b/<orca>')
  })

  it('decodes ProgramArguments, which the doctor stats', () => {
    expect(readExecTarget(plist(hostile))).toEqual({
      interpreter: '/opt/n&de/bin/node',
      script: '/opt/orc&d/orcad.js'
    })
  })

  it('still reads the endpoint out of an escaped argument list', () => {
    expect(readConfiguredEndpoint(plist(hostile))).toEqual({ bind: '127.0.0.1', port: 6800 })
  })

  // Decoding twice would turn a path that literally contains `&lt;` into one containing `<`
  // — the same class of bug in the other direction.
  it('decodes exactly one round, so an entity in the path survives as itself', () => {
    expect(readPinnedUserData(plist({ ...hostile, userDataPath: '/srv/&lt;literal' }))).toBe(
      '/srv/&lt;literal'
    )
  })
})

describe('the systemd command-line splitter', () => {
  it('splits on whitespace outside quotes', () => {
    expect(splitSystemdCommandLine('/bin/node /a/b.js --port 6800')).toEqual([
      '/bin/node',
      '/a/b.js',
      '--port',
      '6800'
    ])
  })

  it('keeps a quoted run together and drops the quotes', () => {
    expect(splitSystemdCommandLine('"/opt/my node/bin/node" --json')).toEqual([
      '/opt/my node/bin/node',
      '--json'
    ])
  })

  it('unescapes a quote and a backslash inside double quotes', () => {
    expect(splitSystemdCommandLine('"/a/with\\"quote" "/b/with\\\\slash"')).toEqual([
      '/a/with"quote',
      '/b/with\\slash'
    ])
  })

  it('yields an empty word for an empty quoted argument rather than dropping it', () => {
    expect(splitSystemdCommandLine('/bin/node "" --json')).toEqual(['/bin/node', '', '--json'])
  })

  it('answers empty for an empty command line', () => {
    expect(splitSystemdCommandLine('')).toEqual([])
    expect(splitSystemdCommandLine('   ')).toEqual([])
  })
})
