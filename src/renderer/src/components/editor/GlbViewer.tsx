import { Box } from 'lucide-react'
import { type JSX, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  createGlbScene,
  decodeBase64ToArrayBuffer,
  disposeGltfModel,
  type GlbSceneHandle
} from './glb-scene'
import { type GlbModelSummary, GlbViewerFooter } from './GlbViewerFooter'
import { type GltfResourceReader, parseGltfModel } from './gltf-model-parse'

type GlbViewerState =
  | { status: 'loading' }
  | { status: 'ready'; summary: GlbModelSummary }
  | { status: 'error'; reason: 'parse' | 'context-lost' }

export default function GlbViewer({
  content,
  format,
  filePath,
  readResource
}: {
  /** Base64 bytes for `glb`, the JSON text for `gltf`. */
  content: string
  format: 'glb' | 'gltf'
  filePath: string
  readResource?: GltfResourceReader
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<GlbSceneHandle | null>(null)
  const [state, setState] = useState<GlbViewerState>({ status: 'loading' })
  const [wireframe, setWireframe] = useState(false)
  const [guidesVisible, setGuidesVisible] = useState(true)
  const [animationIndex, setAnimationIndex] = useState(0)
  const [animationPaused, setAnimationPaused] = useState(false)
  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    setWireframe(false)
    setGuidesVisible(true)
    setAnimationIndex(0)
    setAnimationPaused(false)
    void (async () => {
      try {
        const data =
          format === 'glb' ? decodeBase64ToArrayBuffer(content.replace(/\s/g, '')) : content
        const model = await parseGltfModel(data, readResource)
        if (cancelled) {
          disposeGltfModel(model)
          return
        }
        const handle = createGlbScene(host, model, () => {
          setState({ status: 'error', reason: 'context-lost' })
        })
        sceneRef.current = handle
        // Why autoplay: a still frame cannot show whether the clips were exported at all.
        handle.playAnimation(0)
        setState({
          status: 'ready',
          summary: {
            stats: handle.stats,
            dimensions: handle.dimensions,
            gridCellSize: handle.gridCellSize,
            animationNames: handle.animationNames
          }
        })
      } catch {
        if (!cancelled) {
          setState({ status: 'error', reason: 'parse' })
        }
      }
    })()
    return () => {
      cancelled = true
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
  }, [content, format, readResource])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-orca-glb-viewer>
      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          className={cn('absolute inset-0', state.status === 'error' && 'invisible')}
          aria-label={filename}
          role="img"
        />
        {state.status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {translate('glbPreview.loading', 'Loading 3D model…')}
          </div>
        )}
        {state.status === 'error' && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-sm text-muted-foreground"
            role="alert"
          >
            <Box size={40} />
            <div>
              {state.reason === 'context-lost'
                ? translate(
                    'glbPreview.contextLost',
                    'The 3D view was reset by the graphics driver. Reopen the file to view it again.'
                  )
                : translate(
                    'glbPreview.parseFailed',
                    'Unable to display this 3D model. It may be corrupt, use an unsupported extension, or reference files that could not be read.'
                  )}
            </div>
          </div>
        )}
      </div>
      <GlbViewerFooter
        filename={filename}
        summary={state.status === 'ready' ? state.summary : null}
        wireframe={wireframe}
        guidesVisible={guidesVisible}
        animationIndex={animationIndex}
        animationPaused={animationPaused}
        onResetView={() => sceneRef.current?.resetView()}
        onWireframeChange={(enabled) => {
          sceneRef.current?.setWireframe(enabled)
          setWireframe(enabled)
        }}
        onGuidesVisibleChange={(visible) => {
          sceneRef.current?.setGuidesVisible(visible)
          setGuidesVisible(visible)
        }}
        onAnimationIndexChange={(index) => {
          sceneRef.current?.playAnimation(index)
          setAnimationIndex(index)
          setAnimationPaused(false)
        }}
        onAnimationPausedChange={(paused) => {
          sceneRef.current?.setAnimationPaused(paused)
          setAnimationPaused(paused)
        }}
      />
    </div>
  )
}
