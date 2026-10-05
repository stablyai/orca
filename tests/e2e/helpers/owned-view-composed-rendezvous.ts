import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { TestInfo } from '@stablyai/playwright-test'

export type ComposedStage = 'ready-to-show' | 'direct-native' | 'modal-blocked' | 'native-restored'

export type PixelSample = {
  name: string
  screenX: number
  screenY: number
  rgb: number[]
  tolerance: number
  radius: number
  role: 'guest' | 'renderer' | 'modal'
}

export type ScreenRect = { x: number; y: number; width: number; height: number }

export type FallbackDiagnostics = {
  attempts: number
  entries: {
    status: 'image-not-ready' | 'point-outside-image' | 'sample-ready'
    content: ScreenRect
    guestZoom: number
    imageSize?: { width: number; height: number }
    point?: { x: number | null; y: number | null }
    proofRgb?: number[]
  }[]
}

export function recordFallbackDiagnostic(
  diagnostics: FallbackDiagnostics,
  entry: FallbackDiagnostics['entries'][number]
) {
  diagnostics.attempts += 1
  if (diagnostics.entries.length >= 64) {
    diagnostics.entries.shift()
  }
  diagnostics.entries.push(entry)
}

export type NativeDomProof = { guestId: number; token: string; rgb: number[] }
export type NativeDiscriminator = {
  fallback: {
    path: string
    sha256: string
    proofImagePoint: { x: number; y: number }
    proofRgb: number[]
  }
  fallbackSrcShaBefore: string
  expectedNativeProofRgb: number[]
  nativeDomProof: NativeDomProof
}

type FallbackFrame = Omit<NativeDiscriminator['fallback'], 'path'> & { bytes: Uint8Array }

export async function retainFallback(frame: FallbackFrame, stage: string, info: TestInfo) {
  const { bytes, sha256, proofImagePoint, proofRgb } = frame
  const file = info.outputPath(`native-discriminator-${stage}-fallback.png`)
  await writeFile(file, bytes, { flag: 'wx' })
  await info.attach(path.basename(file), { path: file, contentType: 'image/png' })
  return { path: file, sha256, proofImagePoint, proofRgb }
}

export type ComposedRequest = {
  pid: number
  hwnd: number
  executable: string
  electronVersion: string
  home: string
  userData: string
  owner: { visible: boolean; bounds: ScreenRect; contentBounds: ScreenRect }
  nativeGuest: {
    guestId: number
    visible: boolean
    containerVisible: boolean
    guestVisible: boolean
    container: ScreenRect
    content: ScreenRect
  }
  samples: PixelSample[]
  priorGuestScreenRect?: ScreenRect
  diagnosticMarkers: unknown[]
  nativeDiscriminator?: NativeDiscriminator
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rectangle(value: unknown): value is ScreenRect {
  return (
    record(value) &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) &&
    typeof value.width === 'number' &&
    value.width > 0 &&
    typeof value.height === 'number' &&
    value.height > 0
  )
}

function rgb(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
  )
}

async function optionalJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export class ComposedRendezvous {
  private sequence = 0

  constructor(
    private readonly directory: string,
    private readonly token: string
  ) {
    if (
      !path.isAbsolute(directory) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
    ) {
      throw new Error('Composed capture requires an absolute control directory and UUID token')
    }
  }

  async discriminatorAfter(
    stage: 'direct-native' | 'native-restored',
    evidence: {
      fallbackSrcShaBefore: string
      fallbackSrcShaAfter: string
      fallbackUnchanged: true
      nativeDomProofAfter: NativeDomProof
      expectedNativeProofRgb: number[]
    },
    testInfo: TestInfo
  ) {
    const sequence = stage === 'direct-native' ? 2 : 4
    if (
      this.sequence !== sequence ||
      evidence.fallbackSrcShaBefore !== evidence.fallbackSrcShaAfter
    ) {
      throw new Error('Discriminator after-capture binding changed')
    }
    const file = path.join(this.directory, `discriminator-after-${stage}.json`)
    const temporary = `${file}.${this.token}.tmp`
    await writeFile(
      temporary,
      JSON.stringify({ token: this.token, sequence, stage, ...evidence }, null, 2),
      { flag: 'wx' }
    )
    await link(temporary, file)
    await unlink(temporary)
    await testInfo.attach(`native-discriminator-${stage}-after.json`, {
      path: file,
      contentType: 'application/json'
    })
  }

  async request(stage: ComposedStage, request: ComposedRequest, testInfo: TestInfo): Promise<void> {
    if (!(await stat(this.directory)).isDirectory()) {
      throw new Error('Control directory missing')
    }
    const sequence = ++this.sequence
    const suffix = String(sequence).padStart(3, '0')
    const requestPath = path.join(this.directory, `request-${suffix}.json`)
    const responsePath = path.join(this.directory, `response-${suffix}.json`)
    if ((await optionalJson(responsePath)) !== undefined) {
      throw new Error('Response predates request')
    }
    const envelope = { token: this.token, sequence, stage, ...request }
    const temporary = `${requestPath}.${this.token}.tmp`
    await writeFile(temporary, JSON.stringify(envelope, null, 2), { flag: 'wx' })
    // Hard-link publication is atomic and refuses an existing sequence.
    await link(temporary, requestPath)
    await unlink(temporary)
    await testInfo.attach(`${stage}-request.json`, {
      path: requestPath,
      contentType: 'application/json'
    })
    const deadline = performance.now() + 35_000
    let response: unknown
    while (performance.now() < deadline) {
      const abort = await optionalJson(path.join(this.directory, 'abort.json'))
      if (abort !== undefined) {
        if (!record(abort) || abort.token !== this.token) {
          throw new Error('Invalid supervisor abort')
        }
        throw new Error(`Supervisor aborted composed capture: ${String(abort.reason)}`)
      }
      response = await optionalJson(responsePath)
      if (response !== undefined) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (response === undefined) {
      throw new Error(`Composed capture deadline: ${stage}`)
    }
    await testInfo.attach(`${stage}-response.json`, {
      path: responsePath,
      contentType: 'application/json'
    })
    if (
      !record(response) ||
      response.token !== this.token ||
      response.sequence !== sequence ||
      response.stage !== stage
    ) {
      throw new Error('Composed response binding mismatch')
    }
    if (stage === 'ready-to-show') {
      if (
        response.status !== 'permission-to-show' ||
        response.allowShow !== true ||
        request.owner.visible
      ) {
        throw new Error('Hidden owner did not receive explicit show permission')
      }
      return
    }
    const capture = response.capture
    const checks = response.checks
    if (
      response.status !== 'accepted' ||
      !record(capture) ||
      capture.source !== 'installed-helper-computer-get-app-state' ||
      capture.route !== 'win32-copy-from-screen' ||
      capture.pid !== request.pid ||
      capture.hwnd !== request.hwnd ||
      typeof capture.path !== 'string' ||
      !path.isAbsolute(capture.path) ||
      !rectangle(capture.snapshotBounds) ||
      !Number.isInteger(capture.width) ||
      !Number.isInteger(capture.height) ||
      typeof capture.width !== 'number' ||
      capture.width <= 0 ||
      typeof capture.height !== 'number' ||
      capture.height <= 0 ||
      typeof capture.scale !== 'number' ||
      !Number.isFinite(capture.scale) ||
      capture.scale <= 0 ||
      typeof capture.title !== 'string' ||
      capture.targetId !== request.hwnd ||
      typeof capture.requestId !== 'string' ||
      !record(capture.nativeBefore) ||
      !record(capture.nativeAfter) ||
      !record(checks) ||
      checks.identity !== true ||
      checks.bounds !== true ||
      !Array.isArray(checks.pixels)
    ) {
      throw new Error('Composed OS capture metadata was not accepted')
    }
    if (checks.pixels.length !== request.samples.length) {
      throw new Error('Pixel check count mismatch')
    }
    const names = new Set<string>()
    for (const sample of request.samples) {
      if (names.has(sample.name)) {
        throw new Error('Duplicate requested sample')
      }
      names.add(sample.name)
      const matches = checks.pixels.filter((pixel) => record(pixel) && pixel.name === sample.name)
      const pixel: unknown = matches[0]
      if (
        matches.length !== 1 ||
        !record(pixel) ||
        pixel.passed !== true ||
        !rgb(pixel.expectedRgb) ||
        !rgb(pixel.centerRgb) ||
        pixel.expectedRgb.some((channel, index) => channel !== sample.rgb[index]) ||
        typeof pixel.maxDelta !== 'number' ||
        pixel.maxDelta < 0 ||
        pixel.maxDelta > sample.tolerance ||
        !record(pixel.imagePoint) ||
        !Number.isInteger(pixel.imagePoint.x) ||
        !Number.isInteger(pixel.imagePoint.y)
      ) {
        throw new Error(`Composed pixel evidence mismatch: ${sample.name}`)
      }
      if (
        pixel.centerRgb.some(
          (channel, index) => Math.abs(channel - sample.rgb[index]) > sample.tolerance
        ) ||
        typeof pixel.imagePoint.x !== 'number' ||
        typeof pixel.imagePoint.y !== 'number' ||
        Math.abs(pixel.imagePoint.x - (sample.screenX - capture.snapshotBounds.x) * capture.scale) >
          1 ||
        Math.abs(pixel.imagePoint.y - (sample.screenY - capture.snapshotBounds.y) * capture.scale) >
          1
      ) {
        throw new Error(`Composed measured pixel or coordinate mismatch: ${sample.name}`)
      }
    }
    const png = await readFile(capture.path)
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.readUInt32BE(16) !== capture.width ||
      png.readUInt32BE(20) !== capture.height
    ) {
      throw new Error('Captured artifact is not a PNG with the accepted dimensions')
    }
    await testInfo.attach(`${stage}-composed.png`, { path: capture.path, contentType: 'image/png' })
  }
}
