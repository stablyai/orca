import React, { useEffect, useState } from 'react'
import type * as plantUmlNamespace from '@plantuml/core'
import DOMPurify from 'dompurify'
import { detectPlantUmlErrorDiagram, type PlantUmlErrorDiagram } from './plantuml-error-diagram'
import { enqueuePlantUmlRender } from './plantuml-render-queue'
import { translate } from '@/i18n/i18n'

type PlantUmlApi = typeof plantUmlNamespace

// Why: the engine is ~8MB raw (TeaVM-compiled Java + inlined Graphviz wasm), far
// heavier than mermaid, so a static import would wreck cold start. Load on first
// diagram and cache the promise so later blocks reuse one instance.
let enginePromise: Promise<PlantUmlApi> | null = null

function loadPlantUml(): Promise<PlantUmlApi> {
  if (!enginePromise) {
    enginePromise = (async () => {
      // Why: plantuml.js calls a bare `Viz.instance()`, resolved off the global
      // scope. The UMD bundle self-registers on globalThis only when the bundler
      // leaves no CJS `exports` in scope — under Vite's esbuild interop it can
      // take the exports branch instead, so assign explicitly from the namespace.
      const vizModule = await import('@plantuml/core/viz-global.js')
      const globalScope = globalThis as typeof globalThis & { Viz?: unknown }
      if (!globalScope.Viz) {
        const candidate = (vizModule as { default?: unknown }).default ?? vizModule
        globalScope.Viz =
          typeof (candidate as { instance?: unknown })?.instance === 'function'
            ? candidate
            : vizModule
      }
      return import('@plantuml/core')
    })().catch((err) => {
      // Why: without this the cache holds a rejected promise, so one failed chunk
      // fetch (offline, or a web build served over a flaky network) disables every
      // diagram until the app restarts. Drop it so the next block retries.
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

type PlantUmlBlockProps = {
  content: string
  isDark: boolean
}

/**
 * Turns a detected error card into banner text. Our own wording is localized; the
 * engine's diagnosis is shown verbatim because it only ever emits English.
 */
function describePlantUmlError(error: PlantUmlErrorDiagram): string {
  if (error.kind === 'unsupported') {
    return translate(
      'auto.components.editor.PlantUmlBlock.unsupportedDiagram',
      'Diagram not supported by this release of PlantUML'
    )
  }
  const body =
    error.kind === 'diagnosis' && error.detail !== undefined
      ? error.detail
      : translate(
          'auto.components.editor.PlantUmlBlock.renderFailed',
          'PlantUML could not render this diagram'
        )
  if (error.line === undefined) {
    return body
  }
  const where = `${translate('auto.components.editor.PlantUmlBlock.line', 'line')} ${error.line}`
  return `${where}: ${body}`
}

function renderDiagram(api: PlantUmlApi, content: string, isDark: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    api.renderToString(
      content.split(/\r\n|\r|\n/),
      resolve,
      (message) => reject(new Error(message || 'Invalid PlantUML syntax')),
      { dark: isDark }
    )
  })
}

/**
 * Renders a PlantUML diagram string as SVG. Falls back to raw source with an
 * error banner if the syntax is invalid — never breaks the rest of the preview.
 */
export default function PlantUmlBlock({ content, isDark }: PlantUmlBlockProps): React.JSX.Element {
  // Why: hold the markup in state rather than writing through a ref. The error
  // branch renders a different subtree, so a ref would be null exactly when we
  // need to clear a stale error — leaving a fixed diagram stuck on the old banner
  // while the user edits.
  const [result, setResult] = useState<{ svg: string } | { error: string }>({ svg: '' })

  useEffect(() => {
    let cancelled = false

    const render = async (): Promise<void> => {
      try {
        const api = await loadPlantUml()
        if (cancelled) {
          return
        }
        const svg = await renderDiagram(api, content, isDark)
        if (cancelled) {
          return
        }
        // Why: bad input still resolves — with a picture of the error carrying an
        // upstream upgrade nag. Surface our own banner instead of drawing theirs.
        const errorDiagram = detectPlantUmlErrorDiagram(svg)
        if (errorDiagram) {
          setResult({ error: describePlantUmlError(errorDiagram) })
          return
        }
        // Why: the engine builds SVG from diagram text that can carry arbitrary
        // labels and embedded links, so sanitize regardless of what it escapes.
        setResult({ svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } }) })
      } catch (err) {
        if (!cancelled) {
          setResult({ error: err instanceof Error ? err.message : 'Invalid PlantUML syntax' })
        }
      }
    }

    enqueuePlantUmlRender(render)
    return () => {
      cancelled = true
    }
  }, [content, isDark])

  if ('error' in result) {
    return (
      <div className="plantuml-block">
        <div className="plantuml-error">
          {translate('auto.components.editor.PlantUmlBlock.diagramError', 'Diagram error:')}{' '}
          {result.error}
        </div>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  return <div className="plantuml-block" dangerouslySetInnerHTML={{ __html: result.svg }} />
}
