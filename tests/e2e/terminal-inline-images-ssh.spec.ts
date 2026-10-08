import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  copyFileIntoDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  recoverDockerSshRelayAfterFault
} from './helpers/docker-ssh-relay-connection'
import {
  clearDockerSshRelayFaults,
  dropDockerSshRelayTransport,
  withStalledDockerSshRelayTarget
} from './helpers/docker-ssh-relay-faults'
import {
  inlineImageProducer,
  enableInlineImages,
  readInlineImageState,
  assertInlineImagePixels
} from './helpers/terminal-inline-image-proof'

test('inline images stay bounded and recover through SSH drop and stall', async ({
  orcaPage
}, testInfo) => {
  test.skip(process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Requires isolated Docker SSH target')
  test.setTimeout(240_000)
  let target: DockerSshRelayTarget | undefined
  try {
    target = startDockerSshRelayTarget(testInfo)
    const producerPath = testInfo.outputPath('image-producer.cjs')
    writeFileSync(producerPath, inlineImageProducer())
    copyFileIntoDockerSshRelayTarget(target, producerPath, '/tmp/image-producer.cjs')
    await waitForSessionReady(orcaPage)
    const remote = await connectDockerSshRelayTarget(orcaPage, target, {
      relayGracePeriodSeconds: 0
    })
    const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
    await enableInlineImages(orcaPage)
    const emit = async (stage: string) => {
      await execInTerminal(orcaPage, ptyId, `node /tmp/image-producer.cjs ${stage}`)
      await waitForTerminalOutput(orcaPage, `IMAGE_PROOF_${stage}`, 30_000)
      await assertInlineImagePixels(orcaPage, testInfo.outputPath(`${stage}.png`))
    }
    await emit('before-drop')
    await execInTerminal(orcaPage, ptyId, 'export IMAGE_SHELL_ID=$$')
    await recoverDockerSshRelayAfterFault(orcaPage, remote.targetId, () => {
      expect(dropDockerSshRelayTransport(target!)).toBeGreaterThan(0)
    })
    expect(await waitForActivePanePtyId(orcaPage, 60_000)).toBe(ptyId)
    await execInTerminal(
      orcaPage,
      ptyId,
      'test "$IMAGE_SHELL_ID" = "$$" && printf "SHELL_%s\\n" SURVIVED'
    )
    await waitForTerminalOutput(orcaPage, 'SHELL_SURVIVED', 30_000)
    await emit('after-drop')
    await withStalledDockerSshRelayTarget(target, async () => {
      await execInTerminal(orcaPage, ptyId, 'node /tmp/image-producer.cjs after-stall')
      // A timed fault models a silent established TCP connection, not a render wait.
      await new Promise((resolve) => setTimeout(resolve, 1500))
    })
    await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_after-stall', 60_000)
    expect(await waitForActivePanePtyId(orcaPage)).toBe(ptyId)
    await assertInlineImagePixels(orcaPage, testInfo.outputPath('after-stall.png'))
    const floodPath = testInfo.outputPath('image-flood.cjs')
    writeFileSync(
      floodPath,
      `for(let i=1;i<=100;i++) process.stdout.write('\\x1b_Ga=t,f=32,s=1,v=1,i='+i+',m=1,q=2;AAAA\\x1b\\\\'); console.log('FLOOD_'+'DONE');`
    )
    copyFileIntoDockerSshRelayTarget(target, floodPath, '/tmp/image-flood.cjs')
    await execInTerminal(orcaPage, ptyId, 'node /tmp/image-flood.cjs')
    await waitForTerminalOutput(orcaPage, 'FLOOD_DONE', 30_000)
    const flooded = await readInlineImageState(orcaPage)
    expect(flooded?.pending).toBeLessThanOrEqual(2)
    expect(flooded?.decoderBytes).toBeLessThanOrEqual(32_000_000)
    expect(flooded?.storageMB).toBeLessThanOrEqual(32)
    await emit('after-flood-reset')
    expect((await readInlineImageState(orcaPage))?.pending).toBe(0)
    const beforeZoom = await readInlineImageState(orcaPage)
    if (!beforeZoom) {
      throw new Error('Image addon missing before zoom')
    }
    // Without live images on both sides the equality below would hold at 0 === 0.
    expect(beforeZoom.images).toBeGreaterThan(0)
    expect(beforeZoom.storageMB).toBeGreaterThan(0)
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ terminalFontSize: 28 })
    })
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const state = window.__store!.getState()
          return window.__paneManagers?.get(state.activeTabId!)?.getActivePane()?.terminal.options
            .fontSize
        })
      )
      .toBe(28)
    await assertInlineImagePixels(orcaPage, testInfo.outputPath('after-font-zoom.png'))
    const afterZoom = await readInlineImageState(orcaPage)
    if (!afterZoom) {
      throw new Error('Image addon missing after zoom')
    }
    expect(afterZoom.images).toBe(beforeZoom.images)
    expect(afterZoom.storageMB).toBe(beforeZoom.storageMB)
    await testInfo.attach('image-memory-counts', {
      body: JSON.stringify(flooded),
      contentType: 'application/json'
    })
  } finally {
    if (target) {
      clearDockerSshRelayFaults(target)
      cleanupDockerSshRelayTarget(target)
    }
  }
})
