// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  addAppKeyListener,
  installAppKeyboardRouter,
  removeAppKeyListener
} from './app-keyboard-router'

installAppKeyboardRouter(window)

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

function onWindow(listener: (event: KeyboardEvent) => void): void {
  window.addEventListener('keydown', listener, { capture: true })
  cleanups.push(() => window.removeEventListener('keydown', listener, { capture: true }))
}

function onApp(listener: (event: KeyboardEvent) => void): void {
  addAppKeyListener('keydown', listener)
  cleanups.push(() => removeAppKeyListener('keydown', listener))
}

function press(): string[] {
  const seen: string[] = []
  const record = (name: string) => () => seen.push(name)
  const target = document.createElement('textarea')
  document.body.append(target)
  document.addEventListener('keydown', record('document'), { capture: true, once: true })
  target.addEventListener('keydown', record('terminal input'), { once: true })
  cleanups.push(() => target.remove())
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true, bubbles: true })
  )
  return seen
}

describe('app keyboard router', () => {
  // STA-11205: a tab shortcut owner re-registered after the terminal pane still runs first.
  it.each(['pane first', 'app owner first'])(
    'runs app owners ahead of the terminal pane whatever the registration order (%s)',
    (order) => {
      const seen: string[] = []
      const pane = (event: KeyboardEvent): void => {
        seen.push('pane translation')
        event.stopImmediatePropagation()
      }
      const tabSwitch = (event: KeyboardEvent): void => {
        seen.push('tab switch')
        event.stopImmediatePropagation()
      }
      if (order === 'pane first') {
        onWindow(pane)
        onApp(tabSwitch)
      } else {
        onApp(tabSwitch)
        onWindow(pane)
      }
      const tail = press()
      expect([...seen, ...tail]).toEqual(['tab switch'])
    }
  )

  it('leaves the terminal fallback when no app owner claims the key', () => {
    const seen: string[] = []
    onWindow(() => seen.push('pane translation'))
    onApp(() => seen.push('owner declined'))
    const tail = press()
    expect([...seen, ...tail]).toEqual([
      'owner declined',
      'pane translation',
      'document',
      'terminal input'
    ])
  })

  it('keeps native stop semantics between app owners', () => {
    const seen: string[] = []
    onApp((event) => {
      seen.push('stops propagation')
      event.stopPropagation()
    })
    onApp(() => seen.push('later owner'))
    onWindow(() => seen.push('pane'))
    const tail = press()
    expect([...seen, ...tail]).toEqual(['stops propagation', 'later owner', 'pane'])
  })
})
