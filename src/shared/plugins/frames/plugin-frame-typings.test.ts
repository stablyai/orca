// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  exportedTypeShape,
  runtimeShape,
  type TypingsShape
} from '../authoring/plugin-author-typings.test-fixture'
import { buildPluginGuestShellHtml, buildPluginPanelShellHtml } from './plugin-panel-shell'

/** The `window.orca` a frame shell defines, read without leaving it on the test window. */
function frameOrca(html: string): unknown {
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1] ?? ''
  const transport = { send: () => {}, subscribe: () => {} }
  Object.defineProperty(window, '__orcaPluginFrameTransport', {
    value: transport,
    configurable: true
  })
  window.eval(script.replaceAll('configurable: false', 'configurable: true'))
  const orca: unknown = Object.getOwnPropertyDescriptor(window, 'orca')?.value
  Reflect.deleteProperty(window, 'orca')
  return orca
}

function without(shape: TypingsShape, keys: string[]): TypingsShape {
  return typeof shape === 'string'
    ? shape
    : Object.fromEntries(Object.entries(shape).filter(([key]) => !keys.includes(key)))
}

const typings = exportedTypeShape('orca/frame', 'OrcaFrameApi')

describe('orca-frame.d.ts matches window.orca', () => {
  it('declares every member an isolated editor frame gets', () => {
    expect(runtimeShape(frameOrca(buildPluginGuestShellHtml('', 'editor')))).toEqual(typings.shape)
  })

  it('marks optional exactly what an iframe panel lacks', () => {
    const panel = runtimeShape(frameOrca(buildPluginPanelShellHtml('', 'panel')))
    const absent = ['shell', 'files', 'document']
    expect(typings.optional.filter((name) => !name.includes('.')).sort()).toEqual(absent.sort())
    expect(panel).toEqual(without(typings.shape, absent))
  })
})
