import { describe, expect, it } from 'vitest'
import { mapLinuxSocketInodesToPids } from './linux-proc-socket-owner-scanner'

async function* names(values: readonly string[]): AsyncGenerator<string> {
  yield* values
}

describe('mapLinuxSocketInodesToPids', () => {
  it('streams process and descriptor directories while preserving owner resolution', async () => {
    const visitedDirectories: string[] = []
    const result = await mapLinuxSocketInodesToPids(new Set([101, 202]), {
      readDirectoryNames: (directoryPath) => {
        visitedDirectories.push(directoryPath)
        if (directoryPath === '/proc') {
          return names(['self', '41', '42'])
        }
        return names(directoryPath.endsWith('/41/fd') ? ['1', '2'] : ['3'])
      },
      readLink: async (filePath) => {
        if (filePath.endsWith('/41/fd/1')) {
          return 'socket:[101]'
        }
        if (filePath.endsWith('/42/fd/3')) {
          return 'socket:[202]'
        }
        return 'pipe:[9]'
      }
    })

    expect(result).toEqual(
      new Map([
        [101, 41],
        [202, 42]
      ])
    )
    expect(visitedDirectories).toEqual(['/proc', '/proc/41/fd', '/proc/42/fd'])
  })

  it('does not retain an arbitrarily large process-name listing', async () => {
    let yielded = 0
    const result = await mapLinuxSocketInodesToPids(new Set([7]), {
      readDirectoryNames: (directoryPath) => {
        if (directoryPath !== '/proc') {
          return names([])
        }
        return (async function* () {
          for (let pid = 1; pid <= 20_000; pid += 1) {
            yielded += 1
            yield String(pid)
          }
        })()
      },
      readLink: async () => 'socket:[7]'
    })

    expect(yielded).toBe(20_000)
    expect(result.size).toBe(0)
  })
})
