import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// A long tone makes the second request unambiguously arrive during playback.
function notificationTone(): Buffer {
  const rate = 48_000
  const samples = rate * 2
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    const seconds = i / rate
    const envelope = Math.min(1, seconds * 100, (2 - seconds) * 100)
    const frequency = seconds < 0.12 ? 880 : 440
    wav.writeInt16LE(
      Math.round(Math.sin(2 * Math.PI * frequency * seconds) * envelope * 6000),
      44 + i * 2
    )
  }
  return wav
}

test('completion sound restarts during playback without overlapping players', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const soundPath = testInfo.outputPath('notification-tone.wav')
  writeFileSync(soundPath, notificationTone())
  await orcaPage.evaluate(async (soundPath) => {
    const settings = await window.api.settings.get()
    const next = await window.api.settings.set({
      notifications: {
        ...settings.notifications,
        customSoundId: 'custom',
        customSoundPath: soundPath,
        customSoundVolume: 100
      }
    })
    window.__store?.setState({ settings: next })
    window.__store?.getState().openSettingsTarget({ pane: 'notifications', repoId: null })
    window.__store?.getState().openSettingsPage()
  }, soundPath)
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  let isolatedContextId: number | undefined
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.name === 'Electron Isolated Context') {
      isolatedContextId = context.id
    }
  })
  await cdp.send('Runtime.enable')
  expect(isolatedContextId).toBeDefined()
  // Intercept construction only; decoding, seeking and play remain Chromium's real Audio.
  await cdp.send('Runtime.evaluate', {
    contextId: isolatedContextId,
    expression: `(() => {
      const OriginalAudio = Audio;
      const audios = [];
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const chunks = [];
      const recorder = new MediaRecorder(destination.stream);
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.start();
      globalThis.Audio = function (...args) {
        const audio = new OriginalAudio(...args);
        context.createMediaElementSource(audio).connect(destination);
        audios.push(audio);
        return audio;
      };
      globalThis.notificationAudioProbe = { audios, recorder, chunks, context };
      return context.resume();
    })()`,
    awaitPromise: true
  })
  const started = Date.now()
  const first = await orcaPage.evaluate(() => window.api.notifications.playSound())
  expect(first).toEqual({ played: true })
  await orcaPage.waitForTimeout(600)
  const beforeSeek = await cdp.send('Runtime.evaluate', {
    contextId: isolatedContextId,
    expression: 'notificationAudioProbe.audios[0].currentTime',
    returnByValue: true
  })
  expect(beforeSeek.result.value).toBeGreaterThan(0.3)
  const second = await orcaPage.evaluate(() => window.api.notifications.playSound())
  const baseline = process.env.ORCA_NOTIFICATION_SOUND_BASELINE === '1'
  expect(second).toEqual(baseline ? { played: false, reason: 'deduped' } : { played: true })
  const afterSeek = await cdp.send('Runtime.evaluate', {
    contextId: isolatedContextId,
    expression: 'notificationAudioProbe.audios[0].currentTime',
    returnByValue: true
  })
  if (!baseline) {
    expect(afterSeek.result.value).toBeLessThan(0.2)
  }
  await orcaPage.waitForTimeout(2400)
  expect(await orcaPage.evaluate(() => window.api.notifications.playSound())).toEqual({
    played: true
  })
  await orcaPage.waitForTimeout(2200)
  const count = await cdp.send('Runtime.evaluate', {
    contextId: isolatedContextId,
    expression: 'notificationAudioProbe.audios.length',
    returnByValue: true
  })
  expect(count.result.value).toBe(1)
  const recording = await cdp.send('Runtime.evaluate', {
    contextId: isolatedContextId,
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise(resolve => {
      const probe = notificationAudioProbe;
      probe.recorder.onstop = async () => {
        const bytes = new Uint8Array(await new Blob(probe.chunks).arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        resolve(btoa(binary));
      };
      probe.recorder.stop();
    })`
  })
  if (typeof recording.result.value !== 'string') {
    throw new Error('No audio recording')
  }
  writeFileSync(
    testInfo.outputPath('decoded-audio.webm'),
    Buffer.from(recording.result.value, 'base64')
  )
  writeFileSync(
    testInfo.outputPath('playback-results.json'),
    JSON.stringify(
      { baseline, first, second, elapsedMs: Date.now() - started, players: count.result.value },
      null,
      2
    )
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('notification-settings.png') })
  await testInfo.attach('decoded notification audio', {
    path: testInfo.outputPath('decoded-audio.webm'),
    contentType: 'audio/webm'
  })
  await cdp.detach()
})
