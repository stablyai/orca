import { defineFixture } from '@/component-fixtures/component-fixture'
import { useLayoutEffect } from 'react'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'

const CAPTURED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAYAAAABtjuPAAABQ0lEQVR4nO3SsQ3CABAEQfdCFUhUQNHURAcmIiX0Ct0EE//rtMft/jyhctQPsE2ApARISoCkBEhKgKQESEqApARISoCkBEhKgKQESEqApARISoCkBEhKgKQESEqApARISoCkkgDfr8dl6oH5TYCkBEhKgKQESEqApARISoCkBEhKgKQESEqApARISoCkBEhKgKQESEqApARISoCkBEhKgKQESEqApARISoCkBEhKgKQESEqApCYCvPLevxGgAAUowF0CFKAABbhLgAIUoAB3CVCAAhTgLgEKUIAC3CVAAQpQgLsEKEABCnCXAAUoQAHuEqAABSjAXQIUoAAFuEuAAhSgAHcJUIACFOCuyQDhS4CkBEhKgKQESEqApARISoCkBEhKgKQESEqApARISoCkBEhKgKQESEqApARISoCkBEhKgKQ+O//tW85aD0IAAAAASUVORK5CYII='
const LEGACY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAYAAAABtjuPAAACyUlEQVR4nO3ZO24cQBADUd3FpxDg2IHOq/vJiQHL+jjamWaxK2C6O00+CAL26cfzy9uj8/rz18Ny4n3bkrzH08ajNyV9h2MACce3h9D/UYCUEhpD6f04QFIZLSH1fQUgrRRyaD1fA0gshxZiv1cBUksihNrrdYDkslJD7nMEIL20pNB7HAPYUN50GvobBdhSor2BATaVaV9QgG2l2hMQYGO59gMD2FqyvYAANpdtHxCA7aXbAwDghvK9PxzglhE23x0PcNMYG+9FANw0ypY7cQA3jNN+Hx5g80itd9UBbByr7Z56gE2jtdyxDmDDePT3rwdIHpH6bgEWjEl7rwCLRqW8U4CF46a/T4DFI6e+azp1ABPHTntPUioBJo2e8o7U1AJMGH/6+wmpBjiJQHwCHMMgPgGOoRCfAMdwiE+AYwjFJ8AxhOIT4ChC8QkQj3C6CwEuRjjdgQAXI5y+fToCHEQ4fXNCBPgu4rsfAX6I+O5GgF9EfPciwG8ivjsR4H8ivvMR4DfxL+CdCPCL+D/gvQjwQ07iE+HnCPBdbuAT4b8R4J/cxCfCvxGgvwULcCs+ES4HOA1PhIsBToMT4WKAj0YjQgGO4Tv9ue1ZBfA0EhEKcAyfCAUYg0KEAhzHIEIBjiOY/n5CagGmjJ/yjtRUAkwbPe09SakDmDp26rumUwUwfeT09wlwwbiUdwqweFTaewVYOCb13QIsGpH+/tUAW8ZruWMVwLbR2u6pBtg6VutdVQDbR2q/Dw1wyzhb7kQB3DbKpnvjAW4aY+Pd0QC3jLD5/liAG8q3h1CA7aXbRzDA5rLtJRxga8n2AwDYWK49QQC2lWpfIIBNZdobDGBLifYHBNhQXkLoPY4ApJeWFnKf1wGSy0oOtderAKklUULs9xpAYjnE0Hq+ApBWCj2kvo8DJJXRFErvRwFSSmgNof9jAAnHb0j6Dr8BzgnCo9j7ouQAAAAASUVORK5CYII='

const CHANGED_PATH = '/fixtures/images/changed.png'
const LEGACY_PATH = '/fixtures/images/legacy.png'
const CAPTURED_IMAGE = { type: 'image-ref' as const, url: `data:image/png;base64,${CAPTURED_PNG}` }
const CAPTURED_HASH = '71e19fa91002f56f21a0dc212510dd1c122b8e2dff9feb04e4a98fbd54f09f73'
const LEGACY_HASH = '928445648ae7afa868fb7bd8dc0ecb1219d34a2bcdb9d037e008a73abcfdf993'

const pathlessBlocks: NativeChatBlock[] = [
  {
    type: 'tool-call',
    callId: 'capture-pathless',
    name: 'screenshot',
    input: {},
    state: 'completed',
    outputImages: [CAPTURED_IMAGE]
  },
  { type: 'tool-result', callId: 'capture-pathless', output: 'Screenshot captured' }
]
const capturedPathBlocks: NativeChatBlock[] = [
  {
    type: 'tool-call',
    callId: 'capture-path',
    name: 'read',
    input: { path: CHANGED_PATH },
    state: 'completed',
    outputImages: [CAPTURED_IMAGE]
  },
  { type: 'tool-result', callId: 'capture-path', output: 'Image read successfully' }
]
const legacyPathBlocks: NativeChatBlock[] = [
  {
    type: 'tool-call',
    callId: 'legacy-path',
    name: 'read',
    input: { path: LEGACY_PATH },
    state: 'completed'
  },
  { type: 'tool-result', callId: 'legacy-path', output: 'Image read successfully' }
]

// The pre-fix tool projection had no captured-image metadata.
function withoutCapturedOutput(blocks: NativeChatBlock[]): NativeChatBlock[] {
  return blocks.map((block) => {
    if (block.type !== 'tool-call') {
      return block
    }
    const { outputImages: _images, ...previous } = block
    return previous
  })
}

function ToolImageScenario({ blocks }: { blocks: NativeChatBlock[] }): React.JSX.Element {
  useLayoutEffect(() => {
    const readFile = window.api.fs.readFile
    // The path returns different pixels, so captured output must win without a second thumbnail.
    window.api.fs.readFile = async ({ filePath }) => {
      if (filePath !== CHANGED_PATH && filePath !== LEGACY_PATH) {
        throw new Error('Only the fixture image paths are readable')
      }
      return { content: LEGACY_PNG, isBinary: true, mimeType: 'image/png' }
    }
    return () => {
      window.api.fs.readFile = readFile
    }
  }, [])
  return (
    <div className="native-chat-appearance bg-chat-pane p-4 text-chat-foreground">
      <NativeChatToolRun
        blocks={blocks}
        expandSignal={false}
        followsProse={false}
        activeTurnIsWorking={false}
        runtimeContext={{
          target: { kind: 'local' },
          worktreeId: 'tool-image-fixture',
          worktreePath: null
        }}
      />
    </div>
  )
}

async function renderedImageHash(image: HTMLImageElement): Promise<string> {
  await image.decode()
  if (!/^(?:data:image\/|blob:)/.test(image.currentSrc)) {
    throw new Error('Fixture images must use synthetic data or blob URLs')
  }
  const bytes = await (await fetch(image.currentSrc)).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function decodedThumbnails(frame: HTMLElement, expectedHashes: readonly string[]): Promise<void> {
  const count = expectedHashes.length
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(15_000)
    let decoding = false
    const cleanup = () => {
      observer.disconnect()
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(new Error('Tool image thumbnails did not finish loading'))
    }
    const check = () => {
      const images = Array.from(frame.querySelectorAll('img'))
      if (images.length > count) {
        cleanup()
        reject(new Error(`Expected ${count} tool image previews, received ${images.length}`))
        return
      }
      if (images.length !== count || decoding) {
        return
      }
      decoding = true
      void Promise.all(images.map(renderedImageHash)).then(
        (hashes) => {
          cleanup()
          const current = Array.from(frame.querySelectorAll('img'))
          if (
            current.length !== count ||
            current.some((image) => image.naturalWidth !== 160 || image.naturalHeight !== 100) ||
            hashes.some((hash, index) => hash !== expectedHashes[index])
          ) {
            reject(
              new Error(
                'Tool image preview count, decoded dimensions or captured bytes did not match'
              )
            )
            return
          }
          resolve()
        },
        (error: unknown) => {
          cleanup()
          reject(error)
        }
      )
    }
    const observer = new MutationObserver(check)
    observer.observe(frame, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    })
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

function imageFixture(blocks: NativeChatBlock[], expectedHashes: readonly string[], width = 440) {
  return defineFixture({
    width,
    render: () => <ToolImageScenario blocks={blocks} />,
    interact: (frame) => decodedThumbnails(frame, expectedHashes)
  })
}

export const baselinePathless = imageFixture(withoutCapturedOutput(pathlessBlocks), [])
export const pathless = imageFixture(pathlessBlocks, [CAPTURED_HASH])
export const baselineCapturedPath = imageFixture(withoutCapturedOutput(capturedPathBlocks), [
  LEGACY_HASH
])
export const capturedPath = imageFixture(capturedPathBlocks, [CAPTURED_HASH])
export const legacyPath = imageFixture(legacyPathBlocks, [LEGACY_HASH])
export const compact = imageFixture(
  [...capturedPathBlocks, ...legacyPathBlocks],
  [CAPTURED_HASH, LEGACY_HASH],
  360
)
