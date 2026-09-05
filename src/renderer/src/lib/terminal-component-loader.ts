import { createElement, useState } from 'react'
import { lazyWithRetry } from './lazy-with-retry'
import type TerminalComponent from '../components/Terminal'

let loadedTerminal: typeof TerminalComponent | undefined

export async function loadTerminalComponent() {
  const module = await import('../components/Terminal')
  loadedTerminal = module.default
  return module
}

const LazyTerminal = lazyWithRetry(loadTerminalComponent)

export function PreloadedTerminal() {
  // Keep the component type stable if a cold mount finishes loading later.
  const [Component] = useState(() => loadedTerminal ?? LazyTerminal)
  return createElement(Component)
}
