import { describe, expect, it } from 'vitest'
import {
  createDarwinTerminalNameIndex,
  listDarwinTerminalDevices,
  nameDarwinTerminals,
  translateDarwinTerminalDevices,
  type DarwinTerminalNameIndex
} from './darwin-terminal-names'
import { PS_ARGS, parseStrictProcessTableRows } from './process-table-snapshot'

// Shaped like `ps -axo pid=,ppid=,pgid=,tpgid=,stat=,tdev=,lstart=,command=` on macOS: the
// device column is right-aligned `major/minor`, or `??` for no controlling terminal.
const CAPTURE = [
  '  100     1   100   100 Ss+    16/79 Fri Oct  2 20:20:00 2026     /bin/zsh -l',
  '  200   100   200   100 S+     16/79 Fri Oct  2 20:21:07 2026     node 1/2 server.js',
  '  300     1   300     0 Ss        ?? Fri Oct  2 09:00:00 2026     /usr/libexec/logd',
  '  400     1   400   400 Ss+     16/5 Thu Oct  1 23:58:17 2026     claude',
  ''
].join('\n')

const rdev = (major: number, minor: number): number => major * 0x1000000 + minor

function fakeDev(entries: Map<string, number | 'not-a-device'>): {
  deps: Parameters<typeof createDarwinTerminalNameIndex>[0]
  walks: () => number
  statted: string[]
} {
  let walks = 0
  const statted: string[] = []
  return {
    deps: {
      readdir: async () => {
        walks += 1
        return [...entries.keys()]
      },
      lstat: async (path) => {
        statted.push(path)
        const entry = entries.get(path.slice('/dev/'.length))
        if (entry === undefined) {
          throw new Error(`ENOENT: ${path}`)
        }
        return {
          isCharacterDevice: () => entry !== 'not-a-device',
          rdev: entry === 'not-a-device' ? 0 : entry
        }
      }
    },
    walks: () => walks,
    statted
  }
}

describe('PS_ARGS on macOS', () => {
  it.runIf(process.platform === 'darwin')(
    'asks for the device number, never the devname-resolved tty name',
    () => {
      expect(PS_ARGS[1]).toContain('tdev=')
      expect(PS_ARGS[1]).not.toContain('tty=')
    }
  )
})

describe('translateDarwinTerminalDevices', () => {
  it('lists each terminal device once and skips rows without one', () => {
    expect([...listDarwinTerminalDevices(CAPTURE)]).toEqual(['16/79', '16/5'])
  })

  it('rewrites only the device column, into the name tty= prints', () => {
    const names = new Map([
      ['16/79', 'ttys079'],
      ['16/5', 'ttys005']
    ])
    const rows = parseStrictProcessTableRows(
      translateDarwinTerminalDevices(CAPTURE, (device) => names.get(device))
    )

    expect(rows.map((row) => [row.pid, row.tty, row.startTime, row.command])).toEqual([
      [100, 'ttys079', 'Fri Oct  2 20:20:00 2026', '/bin/zsh -l'],
      [200, 'ttys079', 'Fri Oct  2 20:21:07 2026', 'node 1/2 server.js'],
      [300, '??', 'Fri Oct  2 09:00:00 2026', '/usr/libexec/logd'],
      [400, 'ttys005', 'Thu Oct  1 23:58:17 2026', 'claude']
    ])
  })

  it('keeps a device it cannot name in its major/minor spelling', () => {
    const rows = parseStrictProcessTableRows(
      translateDarwinTerminalDevices(CAPTURE, () => undefined)
    )

    expect(rows.map((row) => row.tty)).toEqual(['16/79', '16/79', '??', '16/5'])
  })

  it('leaves rows without the macOS start marker untouched', () => {
    const legacy = '100 1 100 100 Ss+ 16/79 /bin/zsh\n200 1 Ss+ /bin/bash\n'

    expect(listDarwinTerminalDevices(legacy).size).toBe(0)
    expect(translateDarwinTerminalDevices(legacy, () => 'ttys079')).toBe(legacy)
  })
})

describe('createDarwinTerminalNameIndex', () => {
  it('names devices from tty* and console entries only, the first entry winning', async () => {
    const dev = fakeDev(
      new Map<string, number | 'not-a-device'>([
        ['disk0', rdev(1, 0)],
        ['ttys079', rdev(16, 79)],
        ['ttyq9', rdev(16, 79)],
        ['console', rdev(0, 0)],
        ['tty.debug', 'not-a-device']
      ])
    )
    const names = await createDarwinTerminalNameIndex(dev.deps).resolve(new Set(['16/79']))

    expect(names.get('16/79')).toBe('ttys079')
    expect(names.get('0/0')).toBe('console')
    expect(names.has('1/0')).toBe(false)
    expect(dev.statted).not.toContain('/dev/disk0')
  })

  it('walks /dev again for a new terminal, and only once for one it cannot name', async () => {
    const entries = new Map<string, number | 'not-a-device'>([['ttys079', rdev(16, 79)]])
    const dev = fakeDev(entries)
    const index = createDarwinTerminalNameIndex(dev.deps)

    await index.resolve(new Set(['16/79']))
    await index.resolve(new Set(['16/79']))
    expect(dev.walks()).toBe(1)

    // A process still holding a terminal whose node is gone.
    await index.resolve(new Set(['16/80']))
    await index.resolve(new Set(['16/80']))
    expect(dev.walks()).toBe(2)

    // A terminal opened since the last walk.
    entries.set('ttys081', rdev(16, 81))
    const names = await index.resolve(new Set(['16/81']))
    expect(names.get('16/81')).toBe('ttys081')
    expect(dev.walks()).toBe(3)
  })
})

describe('nameDarwinTerminals', () => {
  it('does not touch /dev for a capture with no terminal devices', async () => {
    let resolved = 0
    const index: DarwinTerminalNameIndex = {
      resolve: async () => {
        resolved += 1
        return new Map()
      }
    }
    const capture = '  300     1   300     0 Ss        ?? Fri Oct  2 09:00:00 2026     logd\n'

    expect(await nameDarwinTerminals(capture, index)).toBe(capture)
    expect(resolved).toBe(0)
  })

  it('keeps a readable capture readable when /dev cannot be read', async () => {
    const index: DarwinTerminalNameIndex = {
      resolve: async () => {
        throw new Error('EACCES: /dev')
      }
    }

    expect(await nameDarwinTerminals(CAPTURE, index)).toBe(CAPTURE)
  })

  it('names every terminal of a capture through the index', async () => {
    const index: DarwinTerminalNameIndex = {
      resolve: async () =>
        new Map([
          ['16/79', 'ttys079'],
          ['16/5', 'ttys005']
        ])
    }
    const rows = parseStrictProcessTableRows(await nameDarwinTerminals(CAPTURE, index))

    expect(rows.map((row) => row.tty)).toEqual(['ttys079', 'ttys079', '??', 'ttys005'])
  })
})
