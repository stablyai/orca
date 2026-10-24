import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  HemisphereLight,
  type Material,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { createGlbSceneAnimation } from './glb-scene-animation'
import { createGlbSceneGuides, type GlbModelDimensions } from './glb-scene-guides'
import type { GltfModel } from './gltf-model-parse'

export type GlbModelStats = {
  meshes: number
  vertices: number
  triangles: number
}

export type GlbSceneHandle = {
  stats: GlbModelStats
  dimensions: GlbModelDimensions
  gridCellSize: number
  animationNames: string[]
  resetView: () => void
  setWireframe: (enabled: boolean) => void
  setGuidesVisible: (visible: boolean) => void
  playAnimation: (clipIndex: number) => void
  setAnimationPaused: (paused: boolean) => void
  dispose: () => void
}

export function decodeBase64ToArrayBuffer(content: string): ArrayBuffer {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function collectMeshes(root: Object3D): Mesh[] {
  const meshes: Mesh[] = []
  root.traverse((node) => {
    if (node instanceof Mesh) {
      meshes.push(node)
    }
  })
  return meshes
}

function meshMaterials(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

function measureMeshes(meshes: Mesh[]): GlbModelStats {
  let vertices = 0
  let triangles = 0
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position')
    const count = position?.count ?? 0
    vertices += count
    triangles += Math.floor((mesh.geometry.index?.count ?? count) / 3)
  }
  return { meshes: meshes.length, vertices, triangles }
}

function disposeMeshes(meshes: Mesh[]): void {
  for (const mesh of meshes) {
    mesh.geometry.dispose()
    for (const material of meshMaterials(mesh)) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) {
          value.dispose()
        }
      }
      material.dispose()
    }
  }
}

export function disposeGltfModel(model: GltfModel): void {
  disposeMeshes(collectMeshes(model.scene))
}

/** Mounts a parsed glTF model into `host`, rendering only on camera or size changes. */
export function createGlbScene(
  host: HTMLElement,
  { scene: model, animations }: GltfModel,
  onContextLost: () => void
): GlbSceneHandle {
  const meshes = collectMeshes(model)
  for (const mesh of meshes) {
    // Why: scans exported without normals would otherwise render as flat silhouettes.
    if (!mesh.geometry.getAttribute('normal')) {
      mesh.geometry.computeVertexNormals()
    }
  }

  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.domElement.style.display = 'block'
  host.appendChild(renderer.domElement)

  const scene = new Scene()
  const pmrem = new PMREMGenerator(renderer)
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = environment
  scene.add(new HemisphereLight(0xffffff, 0x444444, 0.6))
  const keyLight = new DirectionalLight(0xffffff, 1.2)
  keyLight.position.set(1, 2, 1.5)
  scene.add(keyLight)
  scene.add(model)

  const camera = new PerspectiveCamera(45, 1, 0.01, 1000)
  const controls = new OrbitControls(camera, renderer.domElement)
  const render = (): void => renderer.render(scene, camera)
  controls.addEventListener('change', render)

  const bounds = new Box3().setFromObject(model)
  const guides = createGlbSceneGuides(bounds)
  scene.add(guides.group)
  const animation = createGlbSceneAnimation(model, animations, renderer, render)
  const center = bounds.getCenter(new Vector3())
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1e-3)
  const resetView = (): void => {
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360)
    camera.near = distance / 100
    camera.far = distance * 100
    camera.position.copy(center).add(new Vector3(0.6, 0.4, 1).normalize().multiplyScalar(distance))
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
    render()
  }

  const resize = (): void => {
    const width = Math.max(host.clientWidth, 1)
    const height = Math.max(host.clientHeight, 1)
    renderer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    render()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)

  const handleContextLost = (event: Event): void => {
    event.preventDefault()
    onContextLost()
  }
  renderer.domElement.addEventListener('webglcontextlost', handleContextLost)

  resize()
  resetView()

  return {
    stats: measureMeshes(meshes),
    dimensions: guides.dimensions,
    gridCellSize: guides.gridCellSize,
    animationNames: animation.clipNames,
    resetView,
    setWireframe: (enabled) => {
      for (const mesh of meshes) {
        for (const material of meshMaterials(mesh)) {
          if ('wireframe' in material) {
            material.wireframe = enabled
          }
        }
      }
      render()
    },
    setGuidesVisible: (visible) => {
      guides.group.visible = visible
      render()
    },
    playAnimation: animation.play,
    setAnimationPaused: (paused) => {
      animation.setPaused(paused)
      render()
    },
    dispose: () => {
      animation.dispose()
      observer.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost)
      controls.dispose()
      disposeMeshes(meshes)
      guides.dispose()
      environment.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }
}
