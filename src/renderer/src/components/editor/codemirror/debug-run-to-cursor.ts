import type { Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView } from '@codemirror/view'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'

const HOVER_WIDTH_CHARS = 4
const BUTTON_SIZE_PX = 20

function buildPlayArrowSvg(): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('fill', 'currentColor')
  const path = document.createElementNS(svgNs, 'path')
  path.setAttribute('d', 'M4.5 3.25v9.5L12 8 4.5 3.25z')
  svg.append(path)
  return svg
}

function resolveHoveredLine(
  textLeft: number,
  charWidth: number,
  clientX: number,
  lineNumber: number,
  lineText: string
): number | null {
  if (clientX < textLeft || clientX - textLeft > charWidth * HOVER_WIDTH_CHARS) {
    return null
  }
  return lineText.trim() ? lineNumber : null
}

export function createDebugRunToCursorExtension(
  filePath: string,
  fileKey: string,
  labels: { runToCursor: string; resume: string }
): Extension {
  return ViewPlugin.fromClass(
    class {
      private button: HTMLButtonElement | null = null
      private hoveredLineNum = -1
      private unsub: () => void

      constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener('mousemove', this.onMouseMove)
        view.scrollDOM.addEventListener('mouseleave', this.onMouseLeave)
        view.scrollDOM.addEventListener('scroll', this.hide)
        this.unsub = useDebugSessionStore.subscribe((s, prev) => {
          if (s.status !== prev.status || s.stoppedLocation !== prev.stoppedLocation) {
            this.hide()
          }
        })
      }

      private onMouseMove = (e: MouseEvent): void => {
        if (e.target instanceof Node && this.button?.contains(e.target)) {
          return
        }
        const dbg = useDebugSessionStore.getState()
        if (dbg.status !== 'stopped' || e.buttons !== 0) {
          this.hide()
          return
        }
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false)
        const block = this.view.lineBlockAtHeight(e.clientY - this.view.documentTop)
        if (pos == null || pos < block.from || pos > block.to) {
          this.hide()
          return
        }
        const line = this.view.state.doc.lineAt(block.from)
        const leftCoord = this.view.coordsAtPos(line.from, 1)?.left
        if (leftCoord == null) {
          this.hide()
          return
        }
        const targetLine = resolveHoveredLine(
          leftCoord,
          this.view.defaultCharacterWidth,
          e.clientX,
          line.number,
          line.text
        )
        if (targetLine == null) {
          this.hide()
          return
        }
        if (targetLine !== this.hoveredLineNum) {
          this.show(targetLine, block.top + this.view.documentTop, line.from)
        }
      }

      private onMouseLeave = (e: MouseEvent): void => {
        if (!(e.relatedTarget instanceof Node && this.button?.contains(e.relatedTarget))) {
          this.hide()
        }
      }

      private show(line1Based: number, topPx: number, lineFrom: number): void {
        this.hide()
        const stopped = useDebugSessionStore.getState().stoppedLocation
        const atStoppedLine =
          stopped != null && stopped.fileKey === fileKey && stopped.line === line1Based
        const label = atStoppedLine ? labels.resume : labels.runToCursor
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'cm-debug-run-to-cursor'
        btn.title = label
        btn.setAttribute('aria-label', label)
        btn.append(buildPlayArrowSvg())
        btn.addEventListener('mousedown', (ev) => ev.preventDefault())
        btn.addEventListener('click', (ev) => {
          ev.preventDefault()
          this.hide()
          const dbg = useDebugSessionStore.getState()
          if (atStoppedLine) {
            void dbg.resume()
          } else {
            void dbg.runToCursor(filePath, line1Based, ev.altKey)
          }
        })
        btn.addEventListener('mouseleave', (ev) => {
          if (
            !(ev.relatedTarget instanceof Node && this.view.scrollDOM.contains(ev.relatedTarget))
          ) {
            this.hide()
          }
        })

        const lineText = this.view.state.doc.lineAt(lineFrom).text
        const indentOffset = lineText.length - lineText.trimStart().length
        const anchorLeft =
          this.view.coordsAtPos(lineFrom + indentOffset)?.left ??
          this.view.contentDOM.getBoundingClientRect().left
        const hostRect = this.view.dom.getBoundingClientRect()
        const lineHeight = this.view.lineBlockAt(lineFrom).height
        btn.style.left = `${anchorLeft - hostRect.left - BUTTON_SIZE_PX - 2}px`
        btn.style.top = `${topPx - hostRect.top + (lineHeight - BUTTON_SIZE_PX) / 2}px`
        this.view.dom.append(btn)
        this.button = btn
        this.hoveredLineNum = line1Based
      }

      hide = (): void => {
        this.button?.remove()
        this.button = null
        this.hoveredLineNum = -1
      }

      destroy(): void {
        this.hide()
        this.unsub()
        this.view.scrollDOM.removeEventListener('mousemove', this.onMouseMove)
        this.view.scrollDOM.removeEventListener('mouseleave', this.onMouseLeave)
        this.view.scrollDOM.removeEventListener('scroll', this.hide)
      }
    }
  )
}
