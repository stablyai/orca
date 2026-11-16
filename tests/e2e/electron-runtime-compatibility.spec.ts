import { test, expect } from './helpers/orca-app'

// Exercise the real sandboxed preload and IPC serialization without recording audio.
test('dictation preserves floating-point samples through the sandboxed preload', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('speech:feedAudio')
    ipcMain.handle(
      'speech:feedAudio',
      (_event, bytes: Uint8Array, sampleRate: number, sessionId: string) => {
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
        if (
          JSON.stringify(Array.from(samples)) !== JSON.stringify([0.25, -0.5, 1]) ||
          sampleRate !== 16000 ||
          sessionId !== 'electron-upgrade'
        ) {
          throw new Error('Dictation audio changed across the preload bridge')
        }
      }
    )
  })
  await orcaPage.evaluate(async () => {
    const samples = new Float32Array([99, 0.25, -0.5, 1, 99]).subarray(1, 4)
    await window.api.speech.feedAudio(samples, 16000, 'electron-upgrade')
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('electron-45-startup.png') })
})

test('background network requests do not automatically select a client certificate', async ({
  electronApp
}) => {
  const result = await electronApp.evaluate(({ app }) => {
    let prevented = false
    let continued = false
    app.emit(
      'select-client-certificate',
      {
        preventDefault: () => {
          prevented = true
        }
      },
      null,
      'https://example.test',
      [],
      () => {
        continued = true
      }
    )
    return { prevented, continued }
  })
  expect(result).toEqual({ prevented: true, continued: true })
})
