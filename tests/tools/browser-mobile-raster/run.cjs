// Real browser.screencast regression; launch an isolated background serve runtime first.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const source = path.resolve(__dirname, '../../..')
const userData = value('--user-data')
const readyFile = value('--ready')
const output = value('--output')
const projectRoot = value('--project-root')
if (![userData, readyFile, output, projectRoot].every(Boolean)) {
  throw new Error('Missing isolated runtime paths')
}
fs.mkdirSync(output, { recursive: true, mode: 0o700 })
const fixture = fs.readFileSync(path.join(__dirname, 'raster-check.html'))
fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 })
const fixturePath = path.join(projectRoot, 'raster-check.html')
if (fs.existsSync(fixturePath)) {
  if (!fs.readFileSync(fixturePath).equals(fixture)) {
    throw new Error('Refusing to overwrite a different fixture')
  }
} else {
  fs.writeFileSync(fixturePath, fixture, { flag: 'wx', mode: 0o600 })
}

const { RuntimeClient } = require(path.join(source, 'out/cli/runtime-client.js'))
const { decodePairingOffer } = require(path.join(source, 'out/shared/pairing.js'))
const { subscribeRemoteRuntimeRequest } = require(
  path.join(source, 'out/shared/remote-runtime-client.js')
)
const { decodeBrowserScreencastFrame } = require(
  path.join(source, 'out/shared/browser-screencast-protocol.js')
)
const pairing = decodePairingOffer(JSON.parse(fs.readFileSync(readyFile, 'utf8')).pairing.url)
const client = new RuntimeClient(userData, 10000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const observations = []
const failures = []
let page
let worktree
let profile
let receiver
let initialSurface
function expect(ok, message) {
  if (!ok) {
    failures.push(message)
  }
}
async function call(method, params) {
  const reply = await client.call(method, params)
  if (!reply.ok) {
    throw new Error(`${method}:${reply.error?.code}`)
  }
  return reply.result
}
function jpegSize(bytes) {
  const b = Buffer.from(bytes)
  if (b[0] !== 255 || b[1] !== 216) {
    throw new Error('Not JPEG')
  }
  let p = 2
  while (p < b.length) {
    if (b[p] !== 255) {
      p++
      continue
    }
    while (b[p] === 255) {
      p++
    }
    const marker = b[p++]
    if (marker === 217 || marker === 218) {
      break
    }
    if (marker === 1 || (marker >= 208 && marker <= 215)) {
      continue
    }
    const length = b.readUInt16BE(p)
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      return { width: b.readUInt16BE(p + 5), height: b.readUInt16BE(p + 3) }
    }
    p += length
  }
  throw new Error('JPEG has no dimensions')
}
async function state() {
  const result = await call('browser.eval', { page, expression: 'window.__rasterProbe()' })
  return JSON.parse(result.result)
}
async function sample(
  label,
  width,
  height,
  maxWidth,
  maxHeight,
  expectedWidth,
  expectedHeight,
  action,
  dpr = 2
) {
  const record = { label, frames: [], events: [], errors: [], firstFrameMs: null }
  const started = Date.now()
  let subscriptionId
  try {
    receiver = await subscribeRemoteRuntimeRequest(
      pairing,
      'browser.screencast',
      {
        page,
        worktree,
        format: 'jpeg',
        quality: 72,
        maxWidth,
        maxHeight,
        viewportWidth: width,
        viewportHeight: height,
        deviceScaleFactor: dpr,
        mobile: true,
        everyNthFrame: 1,
        minFrameIntervalMs: 100
      },
      10000,
      {
        onResponse(reply) {
          if (!reply.ok) {
            record.errors.push(reply.error?.code)
            return
          }
          const event = reply.result
          record.events.push({ type: event?.type, ms: Date.now() - started })
          if (event?.type === 'ready') {
            subscriptionId = event.subscriptionId
          }
        },
        onBinary(bytes) {
          const frame = decodeBrowserScreencastFrame(bytes)
          if (!frame) {
            record.errors.push('frame_decode')
            return
          }
          record.firstFrameMs ??= Date.now() - started
          const buffer = Buffer.from(frame.image)
          const size = jpegSize(buffer)
          const index = record.frames.length
          record.frames.push({
            ...size,
            metadata: frame.metadata,
            seq: frame.seq,
            ms: Date.now() - started,
            hash: crypto.createHash('sha256').update(buffer).digest('hex')
          })
          if (index < 3) {
            fs.writeFileSync(path.join(output, `${label}-${index}.jpg`), buffer, { mode: 0o600 })
          }
        },
        onError(error) {
          record.errors.push(error.code ?? 'transport')
        },
        onClose() {}
      },
      { perMessageDeflate: false }
    )
    await sleep(1200)
    if (action === 'click') {
      const before = await state()
      await call('browser.mouseClick', { page, worktree, x: before.button.x, y: before.button.y })
      const after = await state()
      record.click = { before: before.clicks, after: after.clicks, trusted: after.trusted }
      expect(
        after.clicks === before.clicks + 1 && after.trusted,
        `${label}: trusted CSS-coordinate click`
      )
    }
    if (action === 'reload') {
      await call('browser.reload', { page, worktree })
    }
    await sleep(2800)
    record.dom = await state()
    expect(
      record.firstFrameMs !== null && record.firstFrameMs < 3000,
      `${label}: bounded first frame`
    )
    expect(record.frames.length >= 6, `${label}: continuous changing frames`)
    expect(
      new Set(record.frames.map((frame) => frame.hash)).size >= 4,
      `${label}: changing raster content`
    )
    expect(record.dom.width === width && record.dom.height === height, `${label}: logical viewport`)
    expect(
      record.frames.every(
        (frame) => frame.width === expectedWidth && frame.height === expectedHeight
      ),
      `${label}: encoded pixels must be ${expectedWidth}x${expectedHeight}`
    )
    expect(
      record.frames.every(
        (frame) => frame.metadata.deviceWidth === width && frame.metadata.deviceHeight === height
      ),
      `${label}: CSS coordinate metadata`
    )
    if (subscriptionId) {
      const stopping = Date.now()
      const reply = await receiver.sendRequest(
        'browser.screencast.unsubscribe',
        { subscriptionId },
        4000
      )
      record.stopMs = Date.now() - stopping
      expect(reply.ok && record.stopMs < 1500, `${label}: bounded unsubscribe`)
    }
    expect(record.errors.length === 0, `${label}: no stream errors`)
  } finally {
    receiver?.close()
    receiver = null
    observations.push(record)
    console.log(
      JSON.stringify({
        label,
        frames: record.frames.length,
        firstFrameMs: record.firstFrameMs,
        firstSize: record.frames[0] && [record.frames[0].width, record.frames[0].height],
        stopMs: record.stopMs,
        dom: record.dom,
        click: record.click,
        errors: record.errors
      })
    )
    await sleep(300)
    record.restored = await state()
    expect(
      record.restored.width === initialSurface.width &&
        record.restored.height === initialSurface.height &&
        record.restored.dpr === initialSurface.dpr,
      `${label}: restore original surface after unsubscribe`
    )
  }
}
;(async () => {
  const repo = await call('repo.add', {
    path: projectRoot,
    kind: 'folder',
    displayName: 'Orca 手机高清候选'
  })
  const repoId = repo.repo?.id ?? repo.id
  worktree = `id:${repoId}::${projectRoot}`
  profile = (
    await call('browser.profileCreate', { label: 'mobile-raster-regression', scope: 'isolated' })
  ).profile.id
  page = (
    await call('browser.tabCreate', {
      worktree,
      url: pathToFileURL(fixturePath).href,
      profileId: profile,
      activate: false,
      navigation: 'caller'
    })
  ).browserPageId
  await sleep(500)
  initialSurface = await state()
  await sample('portrait-click', 360, 534, 900, 1335, 720, 1068, 'click')
  await sample('reconnect-reload', 360, 534, 900, 1335, 720, 1068, 'reload')
  await sample('landscape', 534, 360, 1600, 1600, 1068, 720)
  await sample('small-budget', 360, 534, 180, 267, 180, 267)
  await sample('dpr1-budget', 360, 534, 360, 534, 360, 534, undefined, 1)
})()
  .catch((error) => {
    failures.push(error.message)
  })
  .finally(async () => {
    receiver?.close()
    try {
      if (page) {
        await call('browser.tabClose', { page })
      }
      if (profile) {
        await call('browser.profileDelete', { profileId: profile })
      }
    } catch (error) {
      failures.push(`cleanup:${error.message}`)
    }
    fs.writeFileSync(
      path.join(output, 'results.json'),
      JSON.stringify(
        { observations, failures, verdict: failures.length ? 'FAIL' : 'PASS' },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(JSON.stringify({ verdict: failures.length ? 'FAIL' : 'PASS', failures }))
    process.exitCode = failures.length ? 1 : 0
  })
