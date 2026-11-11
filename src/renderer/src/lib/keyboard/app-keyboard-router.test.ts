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

  it('runs a first owner ahead of owners registered before it', () => {
    const seen: string[] = []
    onApp((event) => {
      seen.push('overlay')
      event.stopImmediatePropagation()
    })
    const dictation = (event: KeyboardEvent): void => {
      seen.push('dictation')
      event.stopImmediatePropagation()
    }
    addAppKeyListener('keydown', dictation, { first: true })
    cleanups.push(() => removeAppKeyListener('keydown', dictation))
    const tail = press()
    expect([...seen, ...tail]).toEqual(['dictation'])
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
