import { test } from './helpers/orca-app'
import { assertLayerImagePixels, prepareLayerImage } from './helpers/terminal-inline-image-layers'

test.skip(process.platform !== 'win32', 'WSL PTY image composition requires Windows')

for (const acceleration of ['off', 'on'] as const) {
  for (const z of [-1, -1499999999]) {
    test(`wsl, ${acceleration}: negative z=${z} follows the text and background boundaries`, async ({
      orcaPage
    }, testInfo) => {
      await prepareLayerImage(orcaPage, testInfo, acceleration, z, 255, false, 'wsl')
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('wsl-image-layers.png'), z, 255)
    })
  }
}
