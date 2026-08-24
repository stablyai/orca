import {
  ORCA_BACKGROUND_AREAS,
  type AppearanceBackgroundArea,
  type ResolvedAppearanceBackground,
  getAppearanceBackgroundDomArea,
  resolveAppearanceBackground
} from './appearance-background-settings'
import type { OrcaBackgroundSettings } from '../../../shared/orca-background-settings'
import type { OrcaBackgroundImageLoadResult } from '../../../shared/orca-background-library-types'
import {
  browserBackgroundImageObjectUrls,
  type BackgroundImageObjectUrlApi
} from './background-image-object-url'

export type AppearanceBackgroundImageApi = {
  loadImage: (fileName: string) => Promise<OrcaBackgroundImageLoadResult>
}

type CachedObjectUrl = {
  url: string | null
  promise: Promise<string | null> | null
}

type AppearanceBackgroundRuntimeOptions = {
  imageApi?: AppearanceBackgroundImageApi | null
  backgroundObjectUrls?: BackgroundImageObjectUrlApi
}

const ACTIVE_AREAS_ATTRIBUTE = 'data-orca-background-areas'
const AREA_ATTRIBUTE = 'data-orca-background-area'
const RELATIVE_ATTRIBUTE = 'data-orca-background-relative'
const terminalBackgroundListeners = new Set<() => void>()
let loadedTerminalBackgroundImage: string | null = null
let terminalBackgroundRevision = 0

function setLoadedTerminalBackgroundImage(imageName: string | null): void {
  if (imageName === loadedTerminalBackgroundImage) {
    return
  }
  loadedTerminalBackgroundImage = imageName
  terminalBackgroundRevision += 1
  for (const listener of terminalBackgroundListeners) {
    listener()
  }
}

export function getTerminalAppearanceBackgroundRevision(): number {
  return terminalBackgroundRevision
}

export function subscribeToTerminalAppearanceBackground(listener: () => void): () => void {
  terminalBackgroundListeners.add(listener)
  return () => terminalBackgroundListeners.delete(listener)
}

function getRendererWindow():
  | (Window & { api?: { backgrounds?: AppearanceBackgroundImageApi } })
  | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & { api?: { backgrounds?: AppearanceBackgroundImageApi } })
}

export function getAppearanceBackgroundImageApi(): AppearanceBackgroundImageApi | null {
  const backgrounds = getRendererWindow()?.api?.backgrounds
  return backgrounds && typeof backgrounds.loadImage === 'function' ? backgrounds : null
}

export function isTerminalAppearanceBackgroundActive(
  settings: Partial<OrcaBackgroundSettings> | null | undefined
): boolean {
  const background = resolveAppearanceBackground(settings, 'terminal')
  return background.active && background.imageName === loadedTerminalBackgroundImage
}

export function markAppearanceBackgroundArea(
  element: HTMLElement,
  area: AppearanceBackgroundArea
): void {
  element.setAttribute(AREA_ATTRIBUTE, getAppearanceBackgroundDomArea(area))
  try {
    const position = getComputedStyle(element).position
    if (!position || position === 'static') {
      element.setAttribute(RELATIVE_ATTRIBUTE, '')
    } else {
      element.removeAttribute(RELATIVE_ATTRIBUTE)
    }
  } catch {
    element.setAttribute(RELATIVE_ATTRIBUTE, '')
  }
}

function areaVariable(area: AppearanceBackgroundArea, suffix: string): string {
  return `--orca-background-${getAppearanceBackgroundDomArea(area)}-${suffix}`
}

export class AppearanceBackgroundRuntime {
  private readonly imageApi: AppearanceBackgroundImageApi | null
  private readonly backgroundObjectUrls: BackgroundImageObjectUrlApi
  private readonly objectUrlCache = new Map<string, CachedObjectUrl>()
  private applyVersion = 0
  private disposed = false

  constructor(
    private readonly root: HTMLElement,
    options: AppearanceBackgroundRuntimeOptions = {}
  ) {
    this.imageApi =
      options.imageApi === undefined ? getAppearanceBackgroundImageApi() : options.imageApi
    this.backgroundObjectUrls = options.backgroundObjectUrls ?? browserBackgroundImageObjectUrls
  }

  apply(settings: Partial<OrcaBackgroundSettings> | null | undefined): void {
    if (this.disposed) {
      return
    }
    const version = ++this.applyVersion
    const resolved = ORCA_BACKGROUND_AREAS.map((area) =>
      resolveAppearanceBackground(settings, area)
    )
    const active = resolved.filter(
      (background): background is ResolvedAppearanceBackground & { imageName: string } =>
        background.active && background.imageName !== null
    )

    this.retainOnly(new Set(active.map((background) => background.imageName)))
    this.applyAppearanceVariables(resolved)
    this.clearAreaImages()

    const readyAreas: AppearanceBackgroundArea[] = []
    let readyTerminalImage: string | null = null
    const pending: Promise<{
      area: AppearanceBackgroundArea
      imageName: string
      url: string | null
    }>[] = []
    for (const background of active) {
      const cached = this.objectUrlCache.get(background.imageName)
      if (cached?.url) {
        this.setAreaImage(background.area, cached.url)
        readyAreas.push(background.area)
        if (background.area === 'terminal') {
          readyTerminalImage = background.imageName
        }
        continue
      }
      pending.push(
        this.ensureObjectUrl(background.imageName).then((url) => ({
          area: background.area,
          imageName: background.imageName,
          url
        }))
      )
    }
    this.setReadyAreas(readyAreas, readyTerminalImage)

    if (pending.length > 0) {
      void Promise.all(pending).then((loaded) => {
        if (this.disposed || version !== this.applyVersion) {
          return
        }
        for (const { area, imageName, url } of loaded) {
          if (url) {
            this.setAreaImage(area, url)
            readyAreas.push(area)
            if (area === 'terminal') {
              readyTerminalImage = imageName
            }
          }
        }
        this.setReadyAreas(readyAreas, readyTerminalImage)
      })
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.applyVersion += 1
    this.retainOnly(new Set())
    this.clearAreaImages()
    this.clearAppearanceVariables()
    setLoadedTerminalBackgroundImage(null)
  }

  private applyAppearanceVariables(backgrounds: readonly ResolvedAppearanceBackground[]): void {
    const fit = backgrounds[0]?.fit ?? 'cover'
    this.root.style.setProperty(
      '--orca-background-size',
      fit === 'stretch' ? '100% 100%' : fit === 'tile' ? 'auto' : fit
    )
    this.root.style.setProperty('--orca-background-repeat', fit === 'tile' ? 'repeat' : 'no-repeat')
    for (const background of backgrounds) {
      this.root.style.setProperty(
        areaVariable(background.area, 'opacity'),
        String(background.opacity)
      )
      this.root.style.setProperty(areaVariable(background.area, 'blur'), `${background.blurPx}px`)
      this.root.style.setProperty(
        areaVariable(background.area, 'scale'),
        String(Math.min(2, 1 + background.blurPx / 25))
      )
    }
  }

  private clearAppearanceVariables(): void {
    this.root.style.removeProperty('--orca-background-size')
    this.root.style.removeProperty('--orca-background-repeat')
    for (const area of ORCA_BACKGROUND_AREAS) {
      this.root.style.removeProperty(areaVariable(area, 'opacity'))
      this.root.style.removeProperty(areaVariable(area, 'blur'))
      this.root.style.removeProperty(areaVariable(area, 'scale'))
    }
  }

  private clearAreaImages(): void {
    this.root.removeAttribute(ACTIVE_AREAS_ATTRIBUTE)
    for (const area of ORCA_BACKGROUND_AREAS) {
      this.root.style.removeProperty(areaVariable(area, 'image'))
    }
  }

  private setAreaImage(area: AppearanceBackgroundArea, url: string): void {
    this.root.style.setProperty(areaVariable(area, 'image'), `url("${url}")`)
  }

  private setReadyAreas(
    areas: readonly AppearanceBackgroundArea[],
    terminalImageName: string | null
  ): void {
    setLoadedTerminalBackgroundImage(areas.includes('terminal') ? terminalImageName : null)
    if (areas.length === 0) {
      this.root.removeAttribute(ACTIVE_AREAS_ATTRIBUTE)
      return
    }
    this.root.setAttribute(
      ACTIVE_AREAS_ATTRIBUTE,
      [...new Set(areas.map(getAppearanceBackgroundDomArea))].join(' ')
    )
  }

  private ensureObjectUrl(fileName: string): Promise<string | null> {
    const cached = this.objectUrlCache.get(fileName)
    if (cached?.url) {
      return Promise.resolve(cached.url)
    }
    if (cached?.promise) {
      return cached.promise
    }
    if (!this.imageApi) {
      return Promise.resolve(null)
    }

    const entry: CachedObjectUrl = { url: null, promise: null }
    entry.promise = this.loadObjectUrl(fileName).then((url) => {
      if (this.objectUrlCache.get(fileName) !== entry) {
        if (url) {
          this.backgroundObjectUrls.revoke(url)
        }
        return null
      }
      entry.promise = null
      if (!url) {
        this.objectUrlCache.delete(fileName)
        return null
      }
      entry.url = url
      return url
    })
    this.objectUrlCache.set(fileName, entry)
    return entry.promise
  }

  private async loadObjectUrl(fileName: string): Promise<string | null> {
    try {
      const result = await this.imageApi!.loadImage(fileName)
      if (!result.ok) {
        return null
      }
      return this.backgroundObjectUrls.create(result.data, result.mimeType)
    } catch {
      return null
    }
  }

  private retainOnly(fileNames: ReadonlySet<string>): void {
    for (const [fileName, entry] of this.objectUrlCache) {
      if (fileNames.has(fileName)) {
        continue
      }
      this.objectUrlCache.delete(fileName)
      if (entry.url) {
        this.backgroundObjectUrls.revoke(entry.url)
      }
    }
  }
}
