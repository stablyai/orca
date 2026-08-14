/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyWindowBlurRootClass, WINDOW_BLUR_ROOT_CLASS } from './window-blur-root-class'

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('window blur root class (#8797)', () => {
  it('toggles the root class from the setting', () => {
    const root = document.documentElement

    applyWindowBlurRootClass(root, true)
    expect(root.classList.contains(WINDOW_BLUR_ROOT_CLASS)).toBe(true)

    applyWindowBlurRootClass(root, false)
    expect(root.classList.contains(WINDOW_BLUR_ROOT_CLASS)).toBe(false)
  })

  it('clears the native-shell app root fill so the platform blur material shows through', () => {
    expect(readSource('src/renderer/src/assets/main.css')).toMatch(
      /html\.native-shell\.window-blur,\s*html\.native-shell\.window-blur body,\s*html\.native-shell\.window-blur #root,\s*html\.native-shell\.window-blur \.app-layout\s*\{\s*background: transparent;\s*\}/
    )
  })

  it('drives the class from windowBackgroundBlur in App', () => {
    const appSource = readSource('src/renderer/src/App.tsx')

    expect(appSource).toMatch(
      /applyWindowBlurRootClass\(\s*document\.documentElement,\s*settings\?\.windowBackgroundBlur \?\? false\s*\)/
    )
    expect(appSource).toContain('}, [settings?.windowBackgroundBlur])')
  })
})
