import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  type Object3D,
  type WebGLRenderer
} from 'three'

export type GlbSceneAnimation = {
  clipNames: string[]
  play: (clipIndex: number) => void
  setPaused: (paused: boolean) => void
  dispose: () => void
}

/** Plays a model's clips; the render loop runs only while a clip is playing. */
export function createGlbSceneAnimation(
  root: Object3D,
  clips: AnimationClip[],
  renderer: WebGLRenderer,
  render: () => void
): GlbSceneAnimation {
  const mixer = new AnimationMixer(root)
  let action: AnimationAction | null = null
  let lastFrameTime: number | null = null
  const setLooping = (looping: boolean): void => {
    lastFrameTime = null
    renderer.setAnimationLoop(
      looping
        ? (time) => {
            mixer.update(lastFrameTime === null ? 0 : (time - lastFrameTime) / 1000)
            lastFrameTime = time
            render()
          }
        : null
    )
  }
  return {
    clipNames: clips.map((clip) => clip.name),
    play: (clipIndex) => {
      const clip = clips[clipIndex]
      if (!clip) {
        return
      }
      action?.stop()
      action = mixer.clipAction(clip)
      action.play()
      setLooping(true)
    },
    setPaused: (paused) => {
      if (action) {
        setLooping(!paused)
      }
    },
    dispose: () => {
      renderer.setAnimationLoop(null)
      mixer.stopAllAction()
      mixer.uncacheRoot(root)
    }
  }
}
