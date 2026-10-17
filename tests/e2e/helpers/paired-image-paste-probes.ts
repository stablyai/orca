import type { ElectronApplication } from '@stablyai/playwright-test'

export async function installImagePasteClipboard(app: ElectronApplication) {
  return app.evaluateHandle(({ clipboard, nativeImage }) => {
    const image = nativeImage.createFromBitmap(
      Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0]),
      { width: 2, height: 2 }
    )
    const original = {
      readImage: clipboard.readImage,
      readText: clipboard.readText,
      availableFormats: clipboard.availableFormats,
      readBuffer: clipboard.readBuffer,
      has: clipboard.has
    }
    // Only OS reads are controlled; both processes retain their real import and transport.
    clipboard.readImage = () => image
    clipboard.readText = () => ''
    clipboard.availableFormats = () => ['image/png']
    clipboard.readBuffer = () => Buffer.alloc(0)
    clipboard.has = (format) => format === 'image/png'
    return {
      png: image.toPNG().toString('base64'),
      restore: () => Object.assign(clipboard, original)
    }
  })
}

export async function observeHostImageCommits(app: ElectronApplication, destination: string) {
  return app.evaluateHandle((_electron, directory) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const path = process.getBuiltinModule('node:path')
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const original = fs.copyFile
    const commits: { source: string; destination: string; png: string }[] = []
    fs.copyFile = async (...args) => {
      await original(...args)
      const [source, target] = args
      if (typeof target === 'string' && path.dirname(target) === path.resolve(directory)) {
        commits.push({
          source: String(source),
          destination: target,
          png: (await fs.readFile(target)).toString('base64')
        })
      }
    }
    syncBuiltinESMExports()
    return {
      commits,
      restore: () => {
        fs.copyFile = original
        syncBuiltinESMExports()
      }
    }
  }, destination)
}
