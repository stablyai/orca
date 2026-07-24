import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_CONFIG_INSPECTION_MAX_BYTES } from '../../../../shared/mcp-config-inspection-limits'
import { loadMcpConfigInspections } from './mcp-config-inspection'

function installFilesystemApi(size: number) {
  const readFile = vi.fn().mockResolvedValue({
    content: '{"mcpServers":{"local":{"command":"node"}}}',
    isBinary: false
  })
  vi.stubGlobal('window', {
    api: {
      fs: {
        readDir: vi
          .fn()
          .mockResolvedValue([{ name: '.mcp.json', isDirectory: false, isSymlink: false }]),
        stat: vi.fn().mockResolvedValue({ size, isDirectory: false, mtime: 0 }),
        readFile
      }
    }
  })
  return { readFile }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadMcpConfigInspections file admission', () => {
  it('reads a candidate at the exact byte boundary', async () => {
    const fs = installFilesystemApi(MCP_CONFIG_INSPECTION_MAX_BYTES)

    const inspections = await loadMcpConfigInspections('/repo', undefined)

    expect(inspections[0]).toMatchObject({
      exists: true,
      status: 'valid',
      servers: [{ name: 'local', command: 'node' }]
    })
    expect(fs.readFile).toHaveBeenCalledOnce()
  })

  it('rejects a +1 candidate before renderer IPC materialization', async () => {
    const fs = installFilesystemApi(MCP_CONFIG_INSPECTION_MAX_BYTES + 1)

    const inspections = await loadMcpConfigInspections('/repo', 'ssh-1')

    expect(inspections[0]).toMatchObject({
      exists: true,
      status: 'invalid',
      error: 'MCP config exceeds the inspection size limit.'
    })
    expect(fs.readFile).not.toHaveBeenCalled()
  })
})
