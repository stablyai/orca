import type { ElectronApplication } from '@stablyai/playwright-test'
import path from 'node:path'
import {
  FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY,
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'

export async function omitHostImagePasteCapability(app: ElectronApplication) {
  return app.evaluateHandle(
    async (_electron, { chunks, capability, runtimeCapability }) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const path = process.getBuiltinModule('node:path')
      const { createRequire } = process.getBuiltinModule('node:module')
      // The bundler names the chunk holding the capability list after whichever module shares it.
      const candidates: string[] = []
      for (const name of await fs.readdir(chunks)) {
        if (
          name.endsWith('.js') &&
          (await fs.readFile(path.join(chunks, name), 'utf8')).includes(capability)
        ) {
          candidates.push(name)
        }
      }
      const requireBuilt = createRequire(path.join(chunks, 'image-paste-probe.cjs'))
      const lists = candidates.flatMap((name) =>
        Object.values(requireBuilt(path.join(chunks, name))).filter(
          (value): value is string[] =>
            Array.isArray(value) &&
            value.every((entry) => typeof entry === 'string') &&
            value.includes(capability) &&
            value.includes(runtimeCapability)
        )
      )
      if (lists.length !== 1) {
        throw new Error('Expected the host runtime capability list')
      }
      // Change only the advertised contract in this disposable host, before the client pairs.
      const capabilities = lists[0]
      const index = capabilities.indexOf(capability)
      capabilities.splice(index, 1)
      return { restore: () => capabilities.splice(index, 0, capability) }
    },
    {
      chunks: path.join(process.cwd(), 'out', 'main', 'chunks'),
      capability: FILE_UPLOAD_EXISTING_PARENT_RUNTIME_CAPABILITY,
      runtimeCapability: PROJECT_HOST_SETUP_RUNTIME_CAPABILITY
    }
  )
}

export async function observeImagePasteStaging(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
      throw new Error('Electron invoke handlers unavailable')
    }
    const handlers = ipcMain._invokeHandlers
    const channels = ['clipboard:stageImageForImport', 'clipboard:releaseImageImport']
    const originals = channels.map((channel) => {
      const handler = handlers.get(channel)
      if (typeof handler !== 'function') {
        throw new Error(`Missing handler: ${channel}`)
      }
      return { channel, handler }
    })
    const stages: { handle: string; path: string }[] = []
    const releases: unknown[] = []
    for (const { channel, handler } of originals) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const result: unknown = await handler(...args)
        if (channel === channels[0]) {
          if (
            !result ||
            typeof result !== 'object' ||
            !('handle' in result) ||
            !('path' in result) ||
            typeof result.handle !== 'string' ||
            typeof result.path !== 'string'
          ) {
            throw new Error('Image paste did not stage a snapshot')
          }
          stages.push({ handle: result.handle, path: result.path })
        } else {
          releases.push(args[1])
        }
        return result
      })
    }
    return {
      stages,
      releases,
      restore: () => {
        for (const { channel, handler } of originals) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, handler)
        }
      }
    }
  })
}
